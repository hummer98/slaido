/**
 * PreviewSync の TDD テスト.
 *
 * Cycle 2 (lifecycle) → Cycle 3 (SSE) → Cycle 4 (chokidar 実 fs)
 * → Cycle 5 (重複排除) → Cycle 6 (ログ) → SSE 切断 / counters まとめ.
 *
 * design-review:
 *   - Finding 4: bun:test は既定で順次実行. afterEach で stop() を必ず呼ぶ
 *   - Finding 6: 状態×イベント表に従い不正遷移は throw
 *   - Finding 7: pending / firstSignalAt の reset は fire() に集約
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PreviewSync, type PreviewUpdateInfo } from "./preview-sync";
import type { ChatEvent, OpencodeToolState } from "../opencode/types";

// ---------------------------------------------------------------------------
// テスト用 helpers
// ---------------------------------------------------------------------------

interface TestEnv {
  cwd: string;
  slidesDir: string;
  slidesEntry: string;
  /** start() の subscribe() unsub が呼ばれたかを観測するフラグ */
  unsubscribed: { value: boolean };
  cleanup: () => Promise<void>;
}

let envCounter = 0;

async function setupTestEnv(): Promise<TestEnv> {
  envCounter += 1;
  const cwd = join(tmpdir(), `slaido-t012-${process.pid}-${envCounter}-${Date.now()}`);
  const slidesDir = join(cwd, "slides");
  await mkdir(slidesDir, { recursive: true });
  const slidesEntry = join(slidesDir, "index.html");
  // 初期 HTML を 1 つ置く (ignoreInitial: true で発火されないこと前提).
  // chokidar の awaitWriteFinish がまだ "stabilizing" と判断しないよう,
  // start() より十分先に書き込み, 少し待ってからチェッカを始める.
  await writeFile(slidesEntry, "<html><body>v0</body></html>", "utf8");
  await new Promise((r) => setTimeout(r, 60));

  return {
    cwd,
    slidesDir,
    slidesEntry,
    unsubscribed: { value: false },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

function makeSubscribe(env: TestEnv) {
  const handlers = new Set<(e: ChatEvent) => void>();
  return {
    subscribe: (handler: (e: ChatEvent) => void) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        env.unsubscribed.value = true;
      };
    },
    emit: (e: ChatEvent) => {
      for (const h of handlers) h(e);
    },
  };
}

function makeToolStatus(args: {
  tool: string;
  status: "pending" | "running" | "completed";
  filePath?: string;
  inputKey?: "filePath" | "file_path" | "file" | "path";
}): ChatEvent {
  const inputKey = args.inputKey ?? "filePath";
  const input: Record<string, unknown> =
    args.filePath !== undefined ? { [inputKey]: args.filePath } : {};
  const state = { status: args.status, input } as unknown as OpencodeToolState;
  return {
    type: "tool-status",
    sessionId: "s1",
    messageId: "m1",
    partId: "p1",
    callId: "c1",
    tool: args.tool,
    state,
    raw: undefined as never,
  };
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Cycle 2: lifecycle
// ---------------------------------------------------------------------------

describe("PreviewSync lifecycle", () => {
  let env: TestEnv;
  let sync: PreviewSync;

  beforeEach(async () => {
    env = await setupTestEnv();
    sync = new PreviewSync({ debounceMs: 30, silent: true });
  });

  afterEach(async () => {
    await sync.stop();
    await env.cleanup();
  });

  test("status starts as 'idle'", () => {
    expect(sync.getStatus()).toBe("idle");
  });

  test("start transitions idle → running", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    expect(sync.getStatus()).toBe("running");
  });

  test("calling start twice while running throws", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    await expect(
      sync.start({
        projectId: "p1",
        cwd: env.cwd,
        slidesEntry: env.slidesEntry,
        subscribeChatEvents: sub.subscribe,
      }),
    ).rejects.toThrow(/already/i);
  });

  test("stop is idempotent", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    await sync.stop();
    await sync.stop(); // 2 度目は no-op
    expect(sync.getStatus()).toBe("stopped");
  });

  test("can re-start after stop", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    await sync.stop();
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    expect(sync.getStatus()).toBe("running");
  });

  test("stop unsubscribes SSE handler", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    expect(env.unsubscribed.value).toBe(false);
    await sync.stop();
    expect(env.unsubscribed.value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cycle 3: SSE 経路の発火
// ---------------------------------------------------------------------------

describe("PreviewSync SSE trigger", () => {
  let env: TestEnv;
  let sync: PreviewSync;
  let sub: ReturnType<typeof makeSubscribe>;
  let updates: PreviewUpdateInfo[];

  beforeEach(async () => {
    env = await setupTestEnv();
    sync = new PreviewSync({ debounceMs: 30, silent: true });
    sub = makeSubscribe(env);
    updates = [];
    sync.onUpdate((info) => updates.push(info));
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
  });

  afterEach(async () => {
    await sync.stop();
    await env.cleanup();
  });

  test("tool-status (edit, completed, slidesEntry) fires onUpdate", async () => {
    sub.emit(
      makeToolStatus({
        tool: "edit",
        status: "completed",
        filePath: env.slidesEntry,
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(1);
    expect(updates[0]!.source).toBe("sse");
    const expected = pathToFileURL(env.slidesEntry).href;
    expect(updates[0]!.url.startsWith(expected)).toBe(true);
    expect(updates[0]!.url).toMatch(/\?t=\d+/);
    expect(sync.getCounters().sseOnly).toBe(1);
  });

  test("write tool also fires", async () => {
    sub.emit(
      makeToolStatus({
        tool: "write",
        status: "completed",
        filePath: env.slidesEntry,
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(1);
    expect(updates[0]!.source).toBe("sse");
  });

  test("multiedit / patch are also accepted (Finding 3)", async () => {
    sub.emit(
      makeToolStatus({
        tool: "multiedit",
        status: "completed",
        filePath: env.slidesEntry,
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(1);
    updates.length = 0;

    sub.emit(
      makeToolStatus({
        tool: "patch",
        status: "completed",
        filePath: env.slidesEntry,
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(1);
  });

  test("status='running' is ignored", async () => {
    sub.emit(
      makeToolStatus({
        tool: "edit",
        status: "running",
        filePath: env.slidesEntry,
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(0);
  });

  test("non-edit tools are ignored (e.g. read)", async () => {
    sub.emit(
      makeToolStatus({
        tool: "read",
        status: "completed",
        filePath: env.slidesEntry,
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(0);
  });

  test("different path is ignored", async () => {
    sub.emit(
      makeToolStatus({
        tool: "edit",
        status: "completed",
        filePath: `${env.slidesDir}/other.html`,
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(0);
  });

  test("falls back to file_path / file / path keys", async () => {
    sub.emit(
      makeToolStatus({
        tool: "edit",
        status: "completed",
        filePath: env.slidesEntry,
        inputKey: "file_path",
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(1);
    updates.length = 0;

    sub.emit(
      makeToolStatus({
        tool: "edit",
        status: "completed",
        filePath: env.slidesEntry,
        inputKey: "file",
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(1);
  });

  test("debounce coalesces multiple SSE signals into 1 reload", async () => {
    for (let i = 0; i < 5; i++) {
      sub.emit(
        makeToolStatus({
          tool: "edit",
          status: "completed",
          filePath: env.slidesEntry,
        }),
      );
    }
    await waitMs(80);
    expect(updates.length).toBe(1);
  });

  test("relative path in input is resolved against cwd", async () => {
    sub.emit(
      makeToolStatus({
        tool: "edit",
        status: "completed",
        filePath: "slides/index.html",
      }),
    );
    await waitMs(80);
    expect(updates.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cycle 4: chokidar 経路の発火 (実 fs)
// ---------------------------------------------------------------------------

describe("PreviewSync chokidar trigger (real fs)", () => {
  let env: TestEnv;
  let sync: PreviewSync;
  let sub: ReturnType<typeof makeSubscribe>;
  let updates: PreviewUpdateInfo[];

  beforeEach(async () => {
    env = await setupTestEnv();
    sync = new PreviewSync({ debounceMs: 30, silent: true });
    sub = makeSubscribe(env);
    updates = [];
    sync.onUpdate((info) => updates.push(info));
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
  });

  afterEach(async () => {
    await sync.stop();
    await env.cleanup();
  });

  test("writing to slidesEntry fires onUpdate (source=chokidar)", async () => {
    await writeFile(env.slidesEntry, "<html><body>v1</body></html>", "utf8");
    // awaitWriteFinish 30ms + debounce 30ms + α
    await waitMs(200);
    expect(updates.length).toBe(1);
    expect(updates[0]!.source).toBe("chokidar");
    expect(sync.getCounters().chokidarOnly).toBe(1);
  });

  test("writes to other.html (different file) are ignored", async () => {
    await writeFile(
      join(env.slidesDir, "other.html"),
      "<html><body>other</body></html>",
      "utf8",
    );
    await waitMs(200);
    expect(updates.length).toBe(0);
  });

  test("swap files (~ / .swp / .tmp) are ignored", async () => {
    await writeFile(
      `${env.slidesEntry}~`,
      "<html><body>swap</body></html>",
      "utf8",
    );
    await writeFile(
      join(env.slidesDir, ".index.html.swp"),
      "vim swp",
      "utf8",
    );
    await writeFile(
      join(env.slidesDir, "index.html.tmp"),
      "<html><body>tmp</body></html>",
      "utf8",
    );
    await waitMs(200);
    expect(updates.length).toBe(0);
  });

  test("multiple writes within debounce are coalesced into 1 reload", async () => {
    await writeFile(env.slidesEntry, "<html><body>v1</body></html>", "utf8");
    await writeFile(env.slidesEntry, "<html><body>v2</body></html>", "utf8");
    await writeFile(env.slidesEntry, "<html><body>v3</body></html>", "utf8");
    // 連続 write は awaitWriteFinish + debounce で 1 回に畳まれる
    await waitMs(300);
    expect(updates.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cycle 5: 重複排除（両経路同時）
// ---------------------------------------------------------------------------

describe("PreviewSync dedup (SSE + chokidar in same window)", () => {
  let env: TestEnv;
  let sync: PreviewSync;
  let sub: ReturnType<typeof makeSubscribe>;
  let updates: PreviewUpdateInfo[];

  beforeEach(async () => {
    env = await setupTestEnv();
    // window を 100ms に広げて両経路を同窓に入れる
    sync = new PreviewSync({ debounceMs: 100, silent: true });
    sub = makeSubscribe(env);
    updates = [];
    sync.onUpdate((info) => updates.push(info));
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
  });

  afterEach(async () => {
    await sync.stop();
    await env.cleanup();
  });

  test("debounce デバウンス挙動: trailing 100ms 静止後に 1 回だけ発火 (Finding 3 / R3)", async () => {
    // 50ms 間隔で 3 回 SSE → 静止 → window 100ms 経過後に 1 回発火
    sub.emit(
      makeToolStatus({ tool: "edit", status: "completed", filePath: env.slidesEntry }),
    );
    await waitMs(40);
    sub.emit(
      makeToolStatus({ tool: "edit", status: "completed", filePath: env.slidesEntry }),
    );
    await waitMs(40);
    sub.emit(
      makeToolStatus({ tool: "edit", status: "completed", filePath: env.slidesEntry }),
    );
    // この時点で最初の signal から 80ms. まだ window 内.
    await waitMs(50);
    expect(updates.length).toBe(0);
    // 最後の signal から 100ms+α 経つと発火する想定.
    await waitMs(100);
    expect(updates.length).toBe(1);
  });

  test("SSE + chokidar within window → 1 reload, source='both', counters.both=1", async () => {
    // chokidar 起動: write して change を発生させる
    await writeFile(env.slidesEntry, "<html><body>v1</body></html>", "utf8");
    // SSE を即座に流す
    sub.emit(
      makeToolStatus({
        tool: "edit",
        status: "completed",
        filePath: env.slidesEntry,
      }),
    );
    // awaitWriteFinish 30 + debounce 100 + α
    await waitMs(250);
    expect(updates.length).toBe(1);
    expect(updates[0]!.source).toBe("both");
    expect(sync.getCounters().both).toBe(1);
    expect(sync.getCounters().sseOnly).toBe(0);
    expect(sync.getCounters().chokidarOnly).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cycle 6: 計測ログ
// ---------------------------------------------------------------------------

describe("PreviewSync structured logging", () => {
  let env: TestEnv;
  let sync: PreviewSync;
  let sub: ReturnType<typeof makeSubscribe>;
  let updates: PreviewUpdateInfo[];
  let originalLog: typeof console.log;
  let logs: string[];

  beforeEach(async () => {
    env = await setupTestEnv();
    // silent: false で実ログを取りに行く
    sync = new PreviewSync({ debounceMs: 30, silent: false });
    sub = makeSubscribe(env);
    updates = [];
    sync.onUpdate((info) => updates.push(info));
    originalLog = console.log;
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
      sessionId: "s-test",
    });
  });

  afterEach(async () => {
    await sync.stop();
    console.log = originalLog;
    await env.cleanup();
  });

  test("preview_sync_reload は JSON ペイロードに source / counters を含む", async () => {
    sub.emit(
      makeToolStatus({
        tool: "edit",
        status: "completed",
        filePath: env.slidesEntry,
      }),
    );
    await waitMs(80);
    const reloadLog = logs.find((l) => l.includes("preview_sync_reload "));
    expect(reloadLog).toBeDefined();
    const jsonText = reloadLog!.replace(/^.*preview_sync_reload /, "");
    const json = JSON.parse(jsonText);
    expect(json.source).toBe("sse");
    expect(json.projectId).toBe("p1");
    expect(json.sessionId).toBe("s-test");
    expect(typeof json.totalSinceFirstSignalMs).toBe("number");
    expect(json.counters).toEqual({ sseOnly: 1, chokidarOnly: 0, both: 0 });
  });

  test("preview_sync_start ログを起動時に 1 行", () => {
    const startLog = logs.find((l) => l.includes("preview_sync_start"));
    expect(startLog).toBeDefined();
    expect(startLog).toContain("projectId=p1");
  });

  test("preview_sync_stop counters=... を停止時に 1 行", async () => {
    await sync.stop();
    const stopLog = logs.find((l) => l.includes("preview_sync_stop counters="));
    expect(stopLog).toBeDefined();
    expect(stopLog).toContain('"sseOnly":0');
  });
});

// ---------------------------------------------------------------------------
// Finding 2: SSE 切断時の動作
// ---------------------------------------------------------------------------

describe("PreviewSync sse-closed handling (Finding 2)", () => {
  let env: TestEnv;
  let sync: PreviewSync;
  let sub: ReturnType<typeof makeSubscribe>;
  let updates: PreviewUpdateInfo[];
  let originalLog: typeof console.log;
  let logs: string[];

  beforeEach(async () => {
    env = await setupTestEnv();
    sync = new PreviewSync({ debounceMs: 30, silent: false });
    sub = makeSubscribe(env);
    updates = [];
    sync.onUpdate((info) => updates.push(info));
    originalLog = console.log;
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
  });

  afterEach(async () => {
    await sync.stop();
    console.log = originalLog;
    await env.cleanup();
  });

  test("error/sse-closed で 1 行ログ + 以後の SSE は無視される", async () => {
    sub.emit({ type: "error", reason: "sse-closed" });
    expect(logs.some((l) => l.includes("preview_sync_sse_closed"))).toBe(true);

    // ログ重複しないこと
    sub.emit({ type: "error", reason: "sse-closed" });
    const occurrences = logs.filter((l) =>
      l.includes("preview_sync_sse_closed"),
    ).length;
    expect(occurrences).toBe(1);

    // 切断後の tool-status は無視される
    sub.emit(
      makeToolStatus({ tool: "edit", status: "completed", filePath: env.slidesEntry }),
    );
    await waitMs(80);
    expect(updates.length).toBe(0);
  });

  test("error/sse-closed 後も chokidar 経路は機能し続ける", async () => {
    sub.emit({ type: "error", reason: "sse-closed" });
    await writeFile(env.slidesEntry, "<html><body>v1</body></html>", "utf8");
    await waitMs(200);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0]!.source).toBe("chokidar");
  });
});

// ---------------------------------------------------------------------------
// R7: invalid HTML 時の skip
// ---------------------------------------------------------------------------

describe("PreviewSync invalid HTML skip (R7)", () => {
  let env: TestEnv;
  let sync: PreviewSync;
  let sub: ReturnType<typeof makeSubscribe>;
  let updates: PreviewUpdateInfo[];

  beforeEach(async () => {
    env = await setupTestEnv();
    sync = new PreviewSync({ debounceMs: 30, silent: true });
    sub = makeSubscribe(env);
    updates = [];
    sync.onUpdate((info) => updates.push(info));
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
  });

  afterEach(async () => {
    await sync.stop();
    await env.cleanup();
  });

  test("空ファイルへの編集は onUpdate を発火しない", async () => {
    await writeFile(env.slidesEntry, "", "utf8");
    sub.emit(
      makeToolStatus({ tool: "edit", status: "completed", filePath: env.slidesEntry }),
    );
    await waitMs(200);
    expect(updates.length).toBe(0);
  });

  test("HTML らしくないテキストへの編集は発火しない", async () => {
    await writeFile(env.slidesEntry, "no tags at all", "utf8");
    sub.emit(
      makeToolStatus({ tool: "edit", status: "completed", filePath: env.slidesEntry }),
    );
    await waitMs(200);
    expect(updates.length).toBe(0);
  });

  test("<!doctype html> から始まるなら有効と扱う", async () => {
    await writeFile(
      env.slidesEntry,
      "<!doctype html>\n<head></head>",
      "utf8",
    );
    sub.emit(
      makeToolStatus({ tool: "edit", status: "completed", filePath: env.slidesEntry }),
    );
    await waitMs(200);
    expect(updates.length).toBeGreaterThan(0);
  });
});
