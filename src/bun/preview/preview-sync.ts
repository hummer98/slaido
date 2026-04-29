/**
 * PreviewSync — opencode が `slides/index.html` を編集した瞬間に WebView の
 * iframe を再ロードさせるための二経路 (SSE tool-status + chokidar) 監視ループ.
 *
 * 設計: plan.md / design-review.md
 *
 *   subscribeChatEvents (ChatBridge.onEvent)
 *                                ┐
 *   chokidar (slides/ 監視)       ┴─→ schedule(source) ─trailing 100ms─▶ fire()
 *                                                                        │
 *                                                            onUpdate({ url, source })
 *
 * - `idle → starting → running → stopping → stopped`
 *   (`stopped` から再 start 可)
 * - 不正遷移は throw (Finding 6)
 * - pending / firstSignalAt の reset は fire() に集約 (Finding 7)
 * - SSE 切断時は SSE 経路を停止し chokidar 単独で続行 (Finding 2)
 */

import { stat as fsStat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { watch as chokidarWatch, type FSWatcher, type ChokidarOptions } from "chokidar";

import { extractToolPath } from "./extract-tool-path";
import type { ChatEvent } from "../opencode/types";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void;

export type PreviewUpdateSource = "sse" | "chokidar" | "both";

export interface PreviewUpdateInfo {
  /** file URL (?t=<unixMillis> 付き). 上位は WebView に投げる. */
  url: string;
  /** 生成時刻 (ms) */
  at: number;
  /** どの経路が contributing したか */
  source: PreviewUpdateSource;
}

export type PreviewUpdateHandler = (info: PreviewUpdateInfo) => void;

export type PreviewSyncStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

export interface PreviewSyncOptions {
  /** デバウンス窓 (ms). 既定 100. */
  debounceMs?: number;
  /** chokidar.watch の override (テスト用). 省略時はデフォルト設定 */
  chokidarOptions?: Partial<ChokidarOptions>;
  /** 計測ログを抑制 (テスト用). 既定 false */
  silent?: boolean;
  /** Date.now の差し替え (テスト用) */
  now?: () => number;
}

export interface PreviewSyncStartArgs {
  projectId: string;
  /** プロジェクト cwd 絶対パス */
  cwd: string;
  /** slides/index.html 絶対パス */
  slidesEntry: string;
  /** ChatEvent を流し込むためのフック登録関数. 通常 ChatBridge.onEvent */
  subscribeChatEvents: (handler: (e: ChatEvent) => void) => Unsubscribe;
  /** 任意. ログ用 */
  sessionId?: string;
}

export interface PreviewSyncCounters {
  sseOnly: number;
  chokidarOnly: number;
  both: number;
}

// ---------------------------------------------------------------------------
// 検知対象 tool 名 (path 編集系のみ).
// design-review Finding 3: multiedit / patch を含めて拡張.
// ---------------------------------------------------------------------------

const PATH_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "patch",
]);

// ---------------------------------------------------------------------------
// 既定 chokidar オプション (plan §2.3 + design-review Finding 1 で v4 確認済み)
// ---------------------------------------------------------------------------

function defaultChokidarOptions(usePolling: boolean): ChokidarOptions {
  return {
    ignored: (p: string) =>
      p.endsWith("~") || p.endsWith(".swp") || p.endsWith(".tmp"),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 10 },
    usePolling,
    followSymlinks: false,
    atomic: 50,
  };
}

// ---------------------------------------------------------------------------
// PreviewSync 本体
// ---------------------------------------------------------------------------

export class PreviewSync {
  private status: PreviewSyncStatus = "idle";
  private readonly debounceMs: number;
  private readonly chokidarOverride?: Partial<ChokidarOptions>;
  private readonly silent: boolean;
  private readonly now: () => number;

  // start() で設定される
  private projectId: string | null = null;
  private cwd: string | null = null;
  private slidesEntry: string | null = null;
  private sessionId: string | null = null;

  private watcher: FSWatcher | null = null;
  private unsubscribeSse: Unsubscribe | null = null;
  private sseAvailable = true;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSources: Set<"sse" | "chokidar"> | null = null;
  private firstSignalAt: number | null = null;
  private lastSseAt: number | null = null;
  private lastFsAt: number | null = null;

  private readonly counters: PreviewSyncCounters = {
    sseOnly: 0,
    chokidarOnly: 0,
    both: 0,
  };
  private lastValidUrl: string | null = null;

  private readonly handlers = new Set<PreviewUpdateHandler>();

  constructor(options: PreviewSyncOptions = {}) {
    this.debounceMs = options.debounceMs ?? 100;
    this.chokidarOverride = options.chokidarOptions;
    this.silent = options.silent ?? false;
    this.now = options.now ?? (() => Date.now());
  }

  getStatus(): PreviewSyncStatus {
    return this.status;
  }

  getCounters(): Readonly<PreviewSyncCounters> {
    return { ...this.counters };
  }

  onUpdate(handler: PreviewUpdateHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async start(args: PreviewSyncStartArgs): Promise<void> {
    if (this.status === "starting" || this.status === "running") {
      throw new Error("PreviewSync: already started");
    }
    if (this.status === "stopping") {
      throw new Error("PreviewSync: cannot start while stopping; await stop() first");
    }

    this.status = "starting";
    this.projectId = args.projectId;
    this.cwd = args.cwd;
    this.slidesEntry = args.slidesEntry;
    this.sessionId = args.sessionId ?? null;
    this.sseAvailable = true;

    // SSE 購読
    this.unsubscribeSse = args.subscribeChatEvents((ev) => this.handleChatEvent(ev));

    // chokidar セットアップ
    const watchPath = await this.computeWatchPath();
    const usePolling =
      typeof process !== "undefined" && process.env?.PREVIEW_SYNC_USE_POLLING === "true";
    const baseOptions = defaultChokidarOptions(usePolling);
    const finalOptions: ChokidarOptions = {
      ...baseOptions,
      ...this.chokidarOverride,
    };

    let watcher: FSWatcher;
    try {
      watcher = chokidarWatch(watchPath, finalOptions);
    } catch (err) {
      this.unsubscribeSse?.();
      this.unsubscribeSse = null;
      this.status = "idle";
      throw err;
    }

    this.watcher = watcher;
    watcher.on("error", (err) => {
      console.error("[preview-sync] chokidar error:", err);
    });
    watcher.on("change", (path) => this.handleFsChange(String(path)));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        watcher.off("error", onError);
        resolve();
      };
      const onError = (err: unknown) => {
        if (settled) return;
        settled = true;
        watcher.off("ready", onReady);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      watcher.once("ready", onReady);
      watcher.once("error", onError);
    });

    this.status = "running";
    if (!this.silent) {
      console.log(
        `[preview-sync] start projectId=${this.projectId} cwd=${this.cwd} slidesEntry=${this.slidesEntry}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.status === "idle" || this.status === "stopped") return;
    if (this.status === "stopping") return;

    this.status = "stopping";

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingSources = null;
    this.firstSignalAt = null;
    this.lastSseAt = null;
    this.lastFsAt = null;

    if (this.unsubscribeSse) {
      try {
        this.unsubscribeSse();
      } catch (err) {
        console.error("[preview-sync] unsubscribe failed:", err);
      }
      this.unsubscribeSse = null;
    }

    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (err) {
        console.error("[preview-sync] watcher close failed:", err);
      }
      this.watcher = null;
    }

    if (!this.silent) {
      console.log(
        `[preview-sync] stop counters=${JSON.stringify(this.counters)}`,
      );
    }

    this.status = "stopped";
  }

  // -------------------------------------------------------------------------
  // 内部: SSE 経路
  // -------------------------------------------------------------------------

  private handleChatEvent(event: ChatEvent): void {
    if (this.status !== "running") return;

    if (event.type === "error" && event.reason === "sse-closed") {
      if (this.sseAvailable) {
        this.sseAvailable = false;
        if (!this.silent) {
          console.log("[preview-sync] sse-closed; running on chokidar only");
        }
      }
      return;
    }

    if (!this.sseAvailable) return;

    if (event.type === "tool-status") {
      this.handleToolStatus(event);
      return;
    }

    if (event.type === "raw") {
      this.handleRawEvent(event);
      return;
    }
  }

  private handleToolStatus(event: Extract<ChatEvent, { type: "tool-status" }>): void {
    if (!PATH_EDIT_TOOLS.has(event.tool)) return;

    const state = event.state as { status?: string };
    if (state.status !== "completed") return;

    const raw = extractToolPath(event.state);
    if (!raw) return;
    if (!this.matchesSlidesEntry(raw)) return;

    this.schedule("sse");
  }

  private handleRawEvent(event: Extract<ChatEvent, { type: "raw" }>): void {
    const raw = event.event as { type?: string; properties?: Record<string, unknown> };
    if (raw?.type !== "file.edited") return;
    const props = raw.properties ?? {};
    const file = props.file;
    if (typeof file !== "string" || file.length === 0) return;
    if (!this.matchesSlidesEntry(file)) return;
    this.schedule("sse");
  }

  // -------------------------------------------------------------------------
  // 内部: chokidar 経路
  // -------------------------------------------------------------------------

  private handleFsChange(path: string): void {
    if (this.status !== "running") return;
    if (!this.matchesSlidesEntry(path)) return;
    this.schedule("chokidar");
  }

  // -------------------------------------------------------------------------
  // パス比較
  // -------------------------------------------------------------------------

  private matchesSlidesEntry(raw: string): boolean {
    if (!this.cwd || !this.slidesEntry) return false;
    const resolved = this.resolvePath(raw);
    return resolved === this.slidesEntry;
  }

  private resolvePath(raw: string): string {
    // 相対 / 絶対の両方をありえるため cwd 基準で resolve.
    // ただし絶対パスの場合は path.resolve は引数をそのまま返す.
    // node:path を使う代わりに簡易版.
    if (raw.startsWith("/")) return raw;
    return `${this.cwd}/${raw}`;
  }

  // -------------------------------------------------------------------------
  // デバウンス + fire
  // -------------------------------------------------------------------------

  private schedule(source: "sse" | "chokidar"): void {
    const now = this.now();
    if (this.pendingSources === null) this.pendingSources = new Set();
    this.pendingSources.add(source);
    if (this.firstSignalAt === null) this.firstSignalAt = now;
    if (source === "sse") this.lastSseAt = now;
    if (source === "chokidar") this.lastFsAt = now;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => this.fire(), this.debounceMs);
  }

  private async fire(): Promise<void> {
    this.debounceTimer = null;
    const sources = this.pendingSources;
    const firstAt = this.firstSignalAt;
    const lastSseAt = this.lastSseAt;
    const lastFsAt = this.lastFsAt;
    // reset 集約 (Finding 7)
    this.pendingSources = null;
    this.firstSignalAt = null;
    this.lastSseAt = null;
    this.lastFsAt = null;

    if (!sources || sources.size === 0) return;
    if (this.status !== "running") return;
    if (!this.slidesEntry) return;

    // HTML サニティチェック (R7)
    const valid = await this.isValidHtml(this.slidesEntry);
    if (!valid) {
      if (!this.silent) {
        console.log(
          `[preview-sync] reload skipped reason=invalid-html slidesEntry=${this.slidesEntry}`,
        );
      }
      return;
    }

    const at = this.now();
    const source: PreviewUpdateSource =
      sources.size === 2 ? "both" : sources.has("sse") ? "sse" : "chokidar";

    if (source === "sse") this.counters.sseOnly += 1;
    else if (source === "chokidar") this.counters.chokidarOnly += 1;
    else this.counters.both += 1;

    const url = this.buildUrl(this.slidesEntry, at);
    this.lastValidUrl = url;

    const info: PreviewUpdateInfo = { url, at, source };

    if (!this.silent) {
      this.logReload({
        source,
        sseToFireMs: lastSseAt !== null ? at - lastSseAt : null,
        fsToFireMs: lastFsAt !== null ? at - lastFsAt : null,
        totalSinceFirstSignalMs: firstAt !== null ? at - firstAt : 0,
        slidesEntry: this.slidesEntry,
      });
    }

    for (const h of this.handlers) {
      try {
        h(info);
      } catch (err) {
        console.error("[preview-sync] handler threw:", err);
      }
    }
  }

  private async isValidHtml(file: string): Promise<boolean> {
    try {
      const s = await fsStat(file);
      if (!s.isFile()) return false;
      if (s.size === 0) return false;
      // 簡易検証: 先頭〜先頭 1KB 内に "<html" が含まれることを期待
      const fd = Bun.file(file);
      const head = await fd.slice(0, 1024).text();
      if (!head.includes("<html") && !head.toLowerCase().includes("<!doctype html")) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private buildUrl(file: string, at: number): string {
    const u = pathToFileURL(file);
    u.search = `?t=${at}`;
    return u.href;
  }

  private logReload(args: {
    source: PreviewUpdateSource;
    sseToFireMs: number | null;
    fsToFireMs: number | null;
    totalSinceFirstSignalMs: number;
    slidesEntry: string;
  }): void {
    const payload: Record<string, unknown> = {
      projectId: this.projectId,
      sessionId: this.sessionId,
      source: args.source,
      sseToFireMs: args.sseToFireMs,
      fsToFireMs: args.fsToFireMs,
      totalSinceFirstSignalMs: args.totalSinceFirstSignalMs,
      counters: { ...this.counters },
    };
    console.log(`[preview-sync] reload ${JSON.stringify(payload)}`);
  }

  private async computeWatchPath(): Promise<string> {
    if (!this.slidesEntry) {
      throw new Error("PreviewSync: slidesEntry not set");
    }
    // ディレクトリ単位で監視
    const idx = this.slidesEntry.lastIndexOf("/");
    return idx >= 0 ? this.slidesEntry.slice(0, idx) : this.slidesEntry;
  }
}
