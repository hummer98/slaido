/**
 * メインプロセス（エントリポイント）
 *
 * BrowserWindow を起動し、WebView との `host-message` / `__SLAIDO_RECEIVE__` 通信骨格を提供する。
 *
 * 起動順 (T009 + T010 統合):
 *   1. ProjectStore を並行 bootstrap
 *   2. BrowserWindow open
 *   3. dom-ready 後に Keychain (or env fallback) からキー取得
 *   4. キー有: opencode サーバを extraEnv で起動 → ChatBridge.init → createSession → open-slides
 *   5. キー無: モーダルを request-api-key で開かせ、submit-api-key 経由で起動・検証
 *
 * before-quit / process.exit 経由で opencode サーバと ChatBridge を停止させる。
 */

import Electrobun, { BrowserWindow, BrowserView } from "electrobun/bun";
import { log, warn, error as logError, fmtErr } from "./logger";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { decodeClientMessage, type ClientMessage } from "./host-message";
import {
  getBundledTemplateRoot,
  getLastOpenedFile,
  getProjectsRoot,
  getRubricPresetsRoot,
} from "./storage/app-paths";
import { ProjectStore } from "./storage/project-store";
import { ProjectStoreError } from "./storage/types";
import type { Project } from "./storage/types";
import { RubricStore } from "./storage/rubric-store";
import { PresetStore } from "./storage/preset-store";
import type { DeckRubric, RubricPreset } from "./storage/rubric-types";
import { buildGeneratePrompt } from "./generate-prompt";
import { InterviewOrchestrator } from "./interview/orchestrator";

import {
  KeychainAdapter,
  KeychainAccessError,
  KeychainUnsupportedError,
} from "./auth/keychain";
import {
  KeyValidationError,
  maskApiKey,
  validateApiKey,
  writeMinimalConfigForValidation,
} from "./auth/key-validator";
import { ChatBridge } from "./opencode/chat-bridge";
import type { ChatEvent } from "./opencode/types";
import { OpencodeServerManager } from "./opencode/server-manager";
import type { OpencodeServerInfo } from "./opencode/server-manager";
import {
  TranscriptLogger,
  buildBaseExtra,
  hashSeed,
  type TranscriptLoggerLike,
} from "./opencode/transcript";
import { PreviewSync } from "./preview/preview-sync";
import {
  handleExportHtmlZip,
  handleExportPdf,
  type ExportProgressMessage,
} from "./export";
import { join as pathJoin } from "node:path";

// E2E テスト時にネイティブ保存ダイアログをバイパスする。
// SLAIDO_E2E_EXPORT_DIR が設定されていれば、ダイアログは表示せず
// `${dir}/${defaultName}` を即座に返す showSaveDialog を注入する
// (defaultName は orchestrator 側で拡張子付きに整形済)。
function buildE2eShowSaveDialog():
  | ((opts: { defaultName: string; filterExt: string }) => Promise<string | null>)
  | undefined {
  const dir = process.env["SLAIDO_E2E_EXPORT_DIR"];
  if (!dir) return undefined;
  return async (opts) => pathJoin(dir, opts.defaultName);
}

type ApiKeyErrorReason =
  | "unauthorized"
  | "rate_limit"
  | "network"
  | "keychain"
  | "startup"
  | "unknown";

type ServerMessage =
  | { type: "message"; role: "assistant"; content: string }
  | { type: "slides"; html: string }
  | { type: "open-slides"; url: string }
  | { type: "error"; message: string }
  | { type: "chat-event"; event: ChatEvent }
  | { type: "project-mode"; mode: "seed" | "chat" }
  | { type: "request-api-key" }
  | { type: "api-key-validated" }
  | { type: "api-key-error"; reason: ApiKeyErrorReason; message?: string }
  | { type: "presets-list"; presets: RubricPreset[] }
  | {
      type: "interview-question";
      turnIndex: number;
      question: string;
      askedCount: number;
      maxQuestions: number;
    }
  | { type: "interview-done"; rubric: DeckRubric }
  | { type: "interview-error"; message: string }
  | { type: "preset-saved"; preset: RubricPreset }
  | ExportProgressMessage;

const VALIDATION_CWD = join(tmpdir(), "slaido-opencode");
const SIGNUP_URL = "https://openrouter.ai/settings/keys";

const LastOpenedSchema = z.object({
  projectId: z.string().min(1),
  lastOpenedAt: z.string().min(1),
});

async function readLastOpened(): Promise<{ projectId: string } | null> {
  const path = getLastOpenedFile();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = LastOpenedSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      void warn("last_opened_parse_failed", `path=${path}`);
      return null;
    }
    return { projectId: parsed.data.projectId };
  } catch (err) {
    // 初回起動など last-opened.json が存在しない場合は ENOENT で握りつぶす。
    // それ以外は warn でメタ情報を残す。
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      void warn("last_opened_read_failed", `path=${path} ${fmtErr(err)}`);
    }
    return null;
  }
}

async function writeLastOpened(projectId: string): Promise<void> {
  const path = getLastOpenedFile();
  await mkdir(dirname(path), { recursive: true });
  const payload = { projectId, lastOpenedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function bootstrapProject(store: ProjectStore): Promise<Project> {
  const lastJson = await readLastOpened();
  let project: Project | null = null;

  if (lastJson?.projectId) {
    try {
      project = await store.load(lastJson.projectId);
    } catch (err) {
      if (
        err instanceof ProjectStoreError &&
        (err.code === "PROJECT_NOT_FOUND" || err.code === "META_CORRUPTED")
      ) {
        void warn(
          "last_opened_project_unavailable",
          `projectId=${lastJson.projectId} code=${err.code}`,
        );
        project = null;
      } else {
        throw err;
      }
    }
  }

  if (!project) {
    project = await store.create({ title: "Untitled", seedText: "" });
  }

  await writeLastOpened(project.meta.id);
  return project;
}

function sendToWebView(win: BrowserWindow, msg: ServerMessage): void {
  win.webview.executeJavascript(
    `window.__SLAIDO_RECEIVE__(${JSON.stringify(msg)})`,
  );
}

/**
 * 当該 slides/index.html を読み、`dist/*.css` / `dist/*.js` への相対参照を
 * 同一フォルダから読んだ inline `<style>` / `<script>` に置換する。
 *
 * これは、Electrobun の親 webview (views://) から子 iframe (file://) を
 * ロードしようとすると WebKit のクロスオリジン制約で空白になる問題への対処。
 * 子 iframe を srcdoc で完結させれば cross-origin に依存しなくなる。
 */
async function loadInlinedSlidesHtml(slidesEntry: string): Promise<string> {
  const html = await readFile(slidesEntry, "utf8");
  const slidesDir = dirname(slidesEntry);
  // <link rel="stylesheet" href="dist/foo.css"> → <style>...</style>
  let out = await replaceAsync(
    html,
    /<link\s+[^>]*href=["']([^"']+\.css)["'][^>]*>/gi,
    async (match, href) => {
      try {
        const css = await readFile(join(slidesDir, href), "utf8");
        return `<style data-inlined-from="${href}">\n${css}\n</style>`;
      } catch {
        return match; // ファイルが無ければ元の link を残す
      }
    },
  );
  // <script src="dist/foo.js"></script> → <script>...</script>
  out = await replaceAsync(
    out,
    /<script\s+[^>]*src=["']([^"']+\.js)["'][^>]*>\s*<\/script>/gi,
    async (match, src) => {
      try {
        const js = await readFile(join(slidesDir, src), "utf8");
        return `<script data-inlined-from="${src}">\n${js}\n</script>`;
      } catch {
        return match;
      }
    },
  );
  return out;
}

async function replaceAsync(
  source: string,
  re: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = Array.from(source.matchAll(re));
  if (matches.length === 0) return source;
  const replacements = await Promise.all(
    matches.map((m) => replacer(m[0], ...(m.slice(1) as string[]))),
  );
  let result = "";
  let last = 0;
  matches.forEach((m, i) => {
    result += source.slice(last, m.index);
    result += replacements[i];
    last = (m.index ?? 0) + m[0].length;
  });
  result += source.slice(last);
  return result;
}

async function generateSlides(
  win: BrowserWindow,
  bridge: ChatBridge | null,
  activeSession: { sessionId: string } | null,
  project: Project | null,
  transcript: TranscriptLoggerLike,
  seedContent: string,
  rubric?: DeckRubric | null,
): Promise<void> {
  if (!bridge || !activeSession) {
    void warn("generate_skipped_no_session", "reason=session_not_initialized");
    sendToWebView(win, { type: "error", message: "セッションが未初期化です" });
    return;
  }
  if (!project) {
    void warn("generate_skipped_no_project", "reason=project_not_initialized");
    sendToWebView(win, { type: "error", message: "プロジェクトが未初期化です" });
    return;
  }
  void log(
    "generate_start",
    `sessionId=${activeSession.sessionId} seedLen=${seedContent.length} slidesEntry=${project.slidesEntry}`,
  );
  const startedAt = Date.now();
  const baseTranscriptExtra = {
    projectId: project.meta.id,
    sessionId: activeSession.sessionId,
    slidesEntry: project.slidesEntry,
    seedLen: seedContent.length,
    seedHash: hashSeed(seedContent),
  };
  transcript.log("slaido_generate_start", {
    phase: "start",
    ...baseTranscriptExtra,
  });
  try {
    await bridge.sendMessage({
      sessionId: activeSession.sessionId,
      parts: [
        {
          type: "text",
          text: buildGeneratePrompt(project.slidesEntry, seedContent, rubric),
        },
      ],
    });
    void log("generate_sent", `sessionId=${activeSession.sessionId}`);
    transcript.log("slaido_generate_end", {
      phase: "end",
      durationMs: Date.now() - startedAt,
      ...baseTranscriptExtra,
    });
  } catch (err) {
    void logError(
      "generate_failed",
      `sessionId=${activeSession.sessionId} ${fmtErr(err)}`,
    );
    transcript.error("slaido_generate_failed", err, {
      phase: "error",
      durationMs: Date.now() - startedAt,
      ...baseTranscriptExtra,
    });
    sendToWebView(win, {
      type: "error",
      message: `生成失敗: ${(err as Error).message}`,
    });
  }
}

async function refineSlides(
  win: BrowserWindow,
  bridge: ChatBridge | null,
  activeSession: { sessionId: string } | null,
  project: Project | null,
  transcript: TranscriptLoggerLike,
  userMessage: string,
): Promise<void> {
  if (!bridge || !activeSession) {
    void warn("refine_skipped_no_session", "reason=session_not_initialized");
    sendToWebView(win, { type: "error", message: "セッションが未初期化です" });
    return;
  }
  void log(
    "refine_start",
    `sessionId=${activeSession.sessionId} msgLen=${userMessage.length}`,
  );
  const startedAt = Date.now();
  const baseTranscriptExtra: Record<string, unknown> = {
    sessionId: activeSession.sessionId,
    msgLen: userMessage.length,
    msgHash: hashSeed(userMessage),
  };
  if (project) {
    baseTranscriptExtra.projectId = project.meta.id;
    baseTranscriptExtra.slidesEntry = project.slidesEntry;
  }
  transcript.log("slaido_refine_start", {
    phase: "start",
    ...baseTranscriptExtra,
  });
  // Edit/Write ツールでファイルを直接修正してもらう。チャットには完了報告だけ。
  const promptText = project
    ? `${userMessage}\n\n対象ファイル: ${project.slidesEntry} を Edit/Write ツールで書き戻してください。チャット欄での応答は完了報告のみ。HTML 本文は貼らない。`
    : userMessage;
  try {
    await bridge.sendMessage({
      sessionId: activeSession.sessionId,
      parts: [{ type: "text", text: promptText }],
    });
    void log("refine_sent", `sessionId=${activeSession.sessionId}`);
    transcript.log("slaido_refine_end", {
      phase: "end",
      durationMs: Date.now() - startedAt,
      ...baseTranscriptExtra,
    });
  } catch (err) {
    void logError(
      "refine_failed",
      `sessionId=${activeSession.sessionId} ${fmtErr(err)}`,
    );
    transcript.error("slaido_refine_failed", err, {
      phase: "error",
      durationMs: Date.now() - startedAt,
      ...baseTranscriptExtra,
    });
    sendToWebView(win, {
      type: "error",
      message: `送信失敗: ${(err as Error).message}`,
    });
  }
}

async function setupPreviewSync(
  win: BrowserWindow,
  project: Project,
  bridge: ChatBridge,
  sessionId: string | null,
): Promise<PreviewSync> {
  const debounceRaw = process.env.PREVIEW_SYNC_DEBOUNCE_MS;
  const debounceMs =
    debounceRaw !== undefined && /^\d+$/.test(debounceRaw)
      ? Number(debounceRaw)
      : undefined;
  const sync = new PreviewSync(debounceMs !== undefined ? { debounceMs } : {});
  sync.onUpdate(async () => {
    // file://直 URL は WebKit cross-origin で iframe が空白になるため、
    // 内容を読んで dist/ アセットを inline した上で srcdoc で渡す。
    try {
      const html = await loadInlinedSlidesHtml(project.slidesEntry);
      sendToWebView(win, { type: "slides", html });
    } catch (err) {
      void logError("slides_inline_failed", `${project.slidesEntry} ${fmtErr(err)}`);
    }
  });
  await sync.start({
    projectId: project.meta.id,
    cwd: project.cwd,
    slidesEntry: project.slidesEntry,
    subscribeChatEvents: (handler) => bridge.onEvent(handler),
    ...(sessionId !== null ? { sessionId } : {}),
  });
  return sync;
}

interface ApiKeyHandlers {
  onSubmitApiKey: (key: string) => void | Promise<void>;
  onResetApiKey: () => void | Promise<void>;
  onOpenSignupUrl: () => void;
}

interface InterviewHandlers {
  start(seedContent: string): void | Promise<void>;
  answer(args: { turnIndex: number; answer: string }): void | Promise<void>;
  cancel(): void | Promise<void>;
  skip(seedContent: string): void | Promise<void>;
  listPresets(): void | Promise<void>;
  usePreset(presetId: string): void | Promise<void>;
  confirmRubric(args: {
    rubric: DeckRubric;
    seed: string;
    alsoSavePreset: boolean;
    presetName?: string;
  }): void | Promise<void>;
}

function attachHandlers(
  win: BrowserWindow,
  getActiveProject: () => Project | null,
  getActiveBridge: () => ChatBridge | null,
  getActiveSession: () => { sessionId: string } | null,
  transcript: TranscriptLoggerLike,
  apiKeyHandlers: ApiKeyHandlers,
  templateRoot: string,
  interviewHandlers: InterviewHandlers,
): void {
  win.on("host-message", (event: unknown) => {
    try {
      const decoded = decodeClientMessage(event);
      if (!decoded.ok) {
        if (decoded.kind === "non_object") {
          void warn("host_message_invalid_event", "reason=non_object");
        } else {
          void warn(
            "host_message_schema_invalid",
            `dataType=${decoded.dataType} typeField=${JSON.stringify(decoded.typeField)} keys=${JSON.stringify(decoded.keys)} issues=${decoded.issuesJson}`,
          );
        }
        return;
      }

      const msg: ClientMessage = decoded.msg;
      void log("host_message_received", `type=${msg.type}`);

      if (msg.type === "ready") {
        void log("client_connected");
        return;
      }

      if (msg.type === "client-warn") {
        void warn(msg.event, msg.detail ?? "");
        return;
      }

      if (msg.type === "generate") {
        void generateSlides(
          win,
          getActiveBridge(),
          getActiveSession(),
          getActiveProject(),
          transcript,
          msg.seedContent,
        );
        return;
      }

      if (msg.type === "chat") {
        void refineSlides(
          win,
          getActiveBridge(),
          getActiveSession(),
          getActiveProject(),
          transcript,
          msg.content,
        );
        return;
      }

      if (msg.type === "chat-cancel") {
        const bridge = getActiveBridge();
        const session = getActiveSession();
        if (bridge && session) {
          void log("chat_cancel_requested", `sessionId=${session.sessionId}`);
          void bridge.abort(session.sessionId);
        } else {
          void warn("chat_cancel_skipped", "reason=no_active_session");
        }
        return;
      }

      if (msg.type === "submit-api-key") {
        void log("api_key_submit_requested", `key=${maskApiKey(msg.key)}`);
        void apiKeyHandlers.onSubmitApiKey(msg.key);
        return;
      }

      if (msg.type === "reset-api-key") {
        void log("api_key_reset_requested");
        void apiKeyHandlers.onResetApiKey();
        return;
      }

      if (msg.type === "open-signup-url") {
        void log("signup_url_open_requested");
        apiKeyHandlers.onOpenSignupUrl();
        return;
      }

      if (msg.type === "export-pdf") {
        const project = getActiveProject();
        if (!project) {
          sendToWebView(win, {
            type: "export-progress",
            kind: "pdf",
            phase: "error",
            message: "プロジェクトが未初期化です",
          });
          return;
        }
        const e2eDialog = buildE2eShowSaveDialog();
        void handleExportPdf(
          {
            title: project.meta.title,
            slidesEntry: project.slidesEntry,
            templateRoot,
          },
          {
            send: (m) => sendToWebView(win, m),
            transcript,
            extra: { projectId: project.meta.id },
            ...(e2eDialog ? { showSaveDialog: e2eDialog } : {}),
          },
        );
        return;
      }

      if (msg.type === "export-html-zip") {
        const project = getActiveProject();
        if (!project) {
          sendToWebView(win, {
            type: "export-progress",
            kind: "html-zip",
            phase: "error",
            message: "プロジェクトが未初期化です",
          });
          return;
        }
        const e2eDialog = buildE2eShowSaveDialog();
        void handleExportHtmlZip(
          {
            title: project.meta.title,
            slidesDir: join(project.cwd, "slides"),
            templateRoot,
          },
          {
            send: (m) => sendToWebView(win, m),
            transcript,
            extra: { projectId: project.meta.id },
            ...(e2eDialog ? { showSaveDialog: e2eDialog } : {}),
          },
        );
        return;
      }

      // T019 — interview / rubric / preset 経路
      if (msg.type === "list-presets") {
        void interviewHandlers.listPresets();
        return;
      }

      if (msg.type === "use-preset") {
        void interviewHandlers.usePreset(msg.presetId);
        return;
      }

      if (msg.type === "interview-start") {
        void interviewHandlers.start(msg.seedContent);
        return;
      }

      if (msg.type === "interview-skip") {
        void interviewHandlers.skip(msg.seedContent);
        return;
      }

      if (msg.type === "interview-answer") {
        void interviewHandlers.answer({
          turnIndex: msg.turnIndex,
          answer: msg.answer,
        });
        return;
      }

      if (msg.type === "interview-cancel") {
        void interviewHandlers.cancel();
        return;
      }

      if (msg.type === "rubric-confirm") {
        const confirmArgs: Parameters<InterviewHandlers["confirmRubric"]>[0] = {
          rubric: msg.rubric,
          seed: msg.seedContent,
          alsoSavePreset: msg.alsoSavePreset,
        };
        if (msg.presetName !== undefined) {
          confirmArgs.presetName = msg.presetName;
        }
        void interviewHandlers.confirmRubric(confirmArgs);
        return;
      }
    } catch (err) {
      void logError("host_message_handler_failed", fmtErr(err));
      transcript.error("slaido_host_message_failed", err);
    }
  });
}

async function determineProjectMode(project: Project): Promise<"seed" | "chat"> {
  try {
    const seedPath = join(project.cwd, "seed", "input.md");
    const content = await readFile(seedPath, "utf8");
    return content.trim() === "" ? "seed" : "chat";
  } catch (err) {
    // seed/input.md が無いケースは seed mode (新規 / 旧プロジェクト)。
    // ENOENT 以外（権限エラー等）は warn でメタ情報を残す。
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      void warn(
        "determine_project_mode_read_failed",
        `projectId=${project.meta.id} ${fmtErr(err)}`,
      );
    }
    return "seed";
  }
}

async function bootstrap(): Promise<void> {
  const projectsRoot = getProjectsRoot();
  const templateRoot = getBundledTemplateRoot();
  const presetsRoot = getRubricPresetsRoot();
  void log("paths_resolved", `projectsRoot=${projectsRoot} templateRoot=${templateRoot} presetsRoot=${presetsRoot}`);

  const store = new ProjectStore(projectsRoot, templateRoot);
  const rubricStore = new RubricStore(projectsRoot);
  const presetStore = new PresetStore(presetsRoot);
  let activeProject: Project | null = null;
  let activeManager: OpencodeServerManager | null = null;
  let activeBridge: ChatBridge | null = null;
  let activeSession: { sessionId: string } | null = null;
  let activePreviewSync: PreviewSync | null = null;
  let projectModeSent = false;
  const keychain = new KeychainAdapter();
  // T019 Risk 5.4: interview 用 session id を持ち、bridge.onEvent から除外する.
  const interviewSessionIds = new Set<string>();

  // TranscriptLogger は bootstrap 冒頭で 1 度だけ構築する。
  // chat-bridge がまだ無い時点 (= 起動直後) でも `slaido_started` を撃ちたいので,
  // client は遅延参照 (`getClient` callback) にして null 期間は no-op + 1 度だけ warn.
  const transcript: TranscriptLoggerLike = new TranscriptLogger({
    getClient: () => activeBridge?.getClient() ?? null,
    baseExtra: buildBaseExtra(),
  });
  transcript.log("slaido_started", { phase: "start" });

  // E2E (bun-mot) 起動時のみ Electrobun の Bun→Browser RPC `maxRequestTime` を無制限にする。
  // デフォルトは 1000ms (electrobun/api/shared/rpc.ts: DEFAULT_MAX_REQUEST_TIME) で、
  // bun-mot の chunkTimeoutMs (5000ms) より短いため WaitFor が 1 秒で reject されてしまう。
  const winRpc = process.env.BUN_MOT_PORT
    ? BrowserView.defineRPC({
        handlers: { requests: {}, messages: {} },
        maxRequestTime: Infinity,
      })
    : undefined;

  const win = new BrowserWindow({
    title: "slAIdo",
    frame: { x: 0, y: 0, width: 1280, height: 800 },
    url: "views://mainview/index.html",
    ...(winRpc ? { rpc: winRpc } : {}),
  });

  // E2E ブリッジ (bun-mot): BUN_MOT_PORT が立っているときだけ bridge を立ち上げる。
  // v0.1.1 で BunMotView シグネチャが Electrobun builtin RPC と一致したのでアダプタ不要。
  if (process.env.BUN_MOT_PORT) {
    const { setupBunMot } = await import("bun-mot/bridge");
    const port = Number(process.env.BUN_MOT_PORT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = setupBunMot(win.webview as any, { port });
    // bun-mot launch() / E2E test runner が stdout 上のマーカー行を待つため、
    // logger ではなく process.stdout.write で直接出す（プロセス間プロトコル）。
    process.stdout.write(`fixture-bridge-ready port=${bridge.port}\n`);
    void log("bunmot_bridge_started", `port=${bridge.port}`);
    process.on("SIGTERM", () => bridge.stop());
  }

  /**
   * R-1: open-slides を送る前に project-mode を一度だけ flush する.
   * WebView 側 reducer の seedMode は project-mode 受信まで null = ローディング状態.
   */
  async function flushProjectModeAndOpen(): Promise<void> {
    if (!activeProject) return;
    if (!projectModeSent) {
      projectModeSent = true;
      const mode = await determineProjectMode(activeProject);
      sendToWebView(win, { type: "project-mode", mode });
    }
    await sendInlinedSlides(activeProject.slidesEntry);
  }

  async function sendInlinedSlides(slidesEntry: string): Promise<void> {
    try {
      const html = await loadInlinedSlidesHtml(slidesEntry);
      sendToWebView(win, { type: "slides", html });
    } catch (err) {
      void logError("slides_inline_failed", `${slidesEntry} ${fmtErr(err)}`);
    }
  }

  bootstrapProject(store)
    .then(async (project) => {
      activeProject = project;
      void log(
        "active_project",
        `id=${project.meta.id} title=${JSON.stringify(project.meta.title)} cwd=${project.cwd}`,
      );
      // 既に opencode が立ち上がっている場合、遅れてやってきた project を反映
      if (activeManager) {
        await flushProjectModeAndOpen();
      }
    })
    .catch((err) => {
      void logError("bootstrap_failed", fmtErr(err));
    });

  /**
   * 既存の ChatBridge / Manager を停止する。再起動 (再入力 / 失敗ロールバック) で利用。
   */
  async function shutdownActiveServer(): Promise<void> {
    if (activePreviewSync) {
      try {
        await activePreviewSync.stop();
      } catch (err) {
        void warn("previous_preview_sync_stop_failed", fmtErr(err));
      }
      activePreviewSync = null;
    }
    if (activeBridge) {
      try {
        await activeBridge.dispose();
      } catch (err) {
        void warn("previous_chat_bridge_dispose_failed", fmtErr(err));
      }
      activeBridge = null;
    }
    activeSession = null;
    if (activeManager) {
      try {
        await activeManager.stop();
      } catch (err) {
        void warn("previous_manager_stop_failed", fmtErr(err));
      }
      activeManager = null;
    }
  }

  /**
   * Keychain にキーが保存されている前提で opencode サーバ + ChatBridge を (再)起動し、
   * 必要なら検証 prompt を打つ。
   *
   * - runValidation: false (2 回目以降の起動) では検証 prompt を省略
   * - 失敗時は activeManager / activeBridge を null に戻し false を返す
   */
  async function startManagerWithKey(
    key: string,
    runValidation: boolean,
  ): Promise<boolean> {
    await shutdownActiveServer();

    try {
      await writeMinimalConfigForValidation(VALIDATION_CWD);
    } catch (err) {
      void logError("opencode_json_write_failed", fmtErr(err));
      sendToWebView(win, {
        type: "api-key-error",
        reason: "startup",
        message: `opencode.json の配置に失敗: ${(err as Error).message}`,
      });
      return false;
    }

    const manager = new OpencodeServerManager({
      workingDirectory: VALIDATION_CWD,
      extraEnv: { OPENROUTER_API_KEY: key },
    });

    let info: OpencodeServerInfo;
    try {
      info = await manager.start();
    } catch (err) {
      void logError("opencode_start_failed", fmtErr(err));
      transcript.error("slaido_opencode_failed", err, { phase: "error" });
      sendToWebView(win, {
        type: "api-key-error",
        reason: "startup",
        message: (err as Error).message,
      });
      return false;
    }
    activeManager = manager;

    if (runValidation) {
      try {
        await validateApiKey({ serverInfo: info });
        void log("api_key_validated", `key=${maskApiKey(key)}`);
      } catch (err) {
        const reason: ApiKeyErrorReason =
          err instanceof KeyValidationError ? err.reason : "unknown";
        const httpStatus =
          err instanceof KeyValidationError ? err.httpStatus : undefined;
        void logError(
          "api_key_validation_failed",
          `key=${maskApiKey(key)} httpStatus=${httpStatus ?? "n/a"} reason=${reason} ${fmtErr(err)}`,
        );
        sendToWebView(win, {
          type: "api-key-error",
          reason,
          message: (err as Error).message,
        });
        try {
          await manager.stop();
        } catch {
          // best-effort
        }
        activeManager = null;
        return false;
      }
    }

    // ChatBridge を初期化 (server 起動成功後)
    const bridge = new ChatBridge();
    bridge.onEvent((ev) => {
      // T019 Risk 5.4: interview 用 session の event は WebView (chat タブ) に転送しない.
      // chat-bridge は subscribe を 1 本で全 session の event を集約する設計のため、
      // ここで session id ベースに filter する.
      const sid = (ev as { sessionId?: unknown }).sessionId;
      if (typeof sid === "string" && interviewSessionIds.has(sid)) return;
      sendToWebView(win, { type: "chat-event", event: ev });
    });

    // LLM 自身が opencode の Write/Edit ツールで slidesEntry を直接書き換える設計。
    // ファイル変更は PreviewSync の chokidar が拾って iframe をリロードする。
    // host 側でチャットテキストから HTML を抽出する経路は廃止 (チャット欄に HTML
    // が出て煩雑だったため)。LLM が tool 呼び出しせず HTML を貼ってしまった場合は
    // ファイルが更新されず警告だけ残す。
    try {
      await bridge.init({
        baseUrl: info.baseUrl,
        password: info.password,
        username: info.username,
      });
    } catch (err) {
      void logError("chat_bridge_init_failed", fmtErr(err));
      transcript.error("slaido_opencode_failed", err, { phase: "error" });
      sendToWebView(win, {
        type: "api-key-error",
        reason: "startup",
        message: `chat-bridge init failed: ${(err as Error).message}`,
      });
      try {
        await bridge.dispose();
      } catch {
        // best-effort
      }
      try {
        await manager.stop();
      } catch {
        // best-effort
      }
      activeManager = null;
      return false;
    }
    activeBridge = bridge;
    void log("chat_bridge_ready");

    // active project があればセッションを作成
    if (activeProject) {
      try {
        activeSession = await bridge.createSession({
          title: activeProject.meta.title,
        });
        void log("active_session", `sessionId=${activeSession.sessionId}`);
      } catch (err) {
        void logError("create_session_failed", fmtErr(err));
        activeSession = null;
      }
    }

    // chat-bridge が立ち上がり client が遅延参照可能になったので, opencode log への
    // inject 経路が開通したことを記録する (slaido_started の warn とは別経路).
    transcript.log("slaido_opencode_ready", {
      phase: "ready",
      ...(activeSession ? { sessionId: activeSession.sessionId } : {}),
      ...(activeProject ? { projectId: activeProject.meta.id } : {}),
    });

    // T012 PreviewSync: SSE tool-status + chokidar の二経路で iframe 再ロードを駆動.
    // 初期 reload は dom-ready ハンドラ / startManagerWithKey 成功後の open-slides に任せる
    // ため PreviewSync は変化時のみ専任 (plan §4.3).
    if (activeProject && activeBridge) {
      try {
        activePreviewSync = await setupPreviewSync(
          win,
          activeProject,
          activeBridge,
          activeSession?.sessionId ?? null,
        );
      } catch (err) {
        void logError("preview_sync_start_failed", fmtErr(err));
        activePreviewSync = null;
      }
    }

    if (runValidation) {
      sendToWebView(win, { type: "api-key-validated" });
    } else {
      void log(
        "opencode_ready",
        `key=${maskApiKey(key)} validation=skipped`,
      );
    }
    return true;
  }

  // T019 — interview / rubric / preset orchestration
  const orchestrator = new InterviewOrchestrator({
    getServerInfo: () => activeManager?.getInfo() ?? null,
    send: (msg) => sendToWebView(win, msg),
    rubricStore,
    presetStore,
    interviewSessionIds,
    getActiveProjectId: () => activeProject?.meta.id ?? null,
    onRubricConfirmed: async ({ rubric, seed }) => {
      await generateSlides(
        win,
        activeBridge,
        activeSession,
        activeProject,
        transcript,
        seed,
        rubric,
      );
    },
    warn: (event, detail) => warn(event, detail ?? ""),
  });

  const interviewHandlers: InterviewHandlers = {
    start: (seedContent) => orchestrator.start(seedContent),
    answer: (args) => orchestrator.answer(args),
    cancel: () => orchestrator.cancel(),
    skip: async (seedContent) => {
      // 空 rubric で生成 (interview を経由しない)
      await generateSlides(
        win,
        activeBridge,
        activeSession,
        activeProject,
        transcript,
        seedContent,
        null,
      );
    },
    listPresets: () => orchestrator.listPresets(),
    usePreset: async (presetId) => {
      // mainview 側で preset.rubric を draftRubric に乗せて rubric-confirm まで進める設計.
      // bun 側ではログだけ残す (将来 "最近使った preset" の統計を取るためのフック).
      void log("interview_use_preset", `presetId=${presetId}`);
    },
    confirmRubric: (args) => orchestrator.confirmRubric(args),
  };

  attachHandlers(
    win,
    () => activeProject,
    () => activeBridge,
    () => activeSession,
    transcript,
    {
      onSubmitApiKey: async (key) => {
        try {
          await keychain.setApiKey(key);
        } catch (err) {
          if (err instanceof KeychainUnsupportedError) {
            sendToWebView(win, {
              type: "api-key-error",
              reason: "keychain",
              message:
                "macOS 以外では env (OPENROUTER_API_KEY) 経由のみサポートします。",
            });
            return;
          }
          if (err instanceof KeychainAccessError) {
            sendToWebView(win, {
              type: "api-key-error",
              reason: "keychain",
              message: err.message,
            });
            return;
          }
          sendToWebView(win, {
            type: "api-key-error",
            reason: "keychain",
            message: (err as Error).message,
          });
          return;
        }
        const ok = await startManagerWithKey(key, true);
        if (ok && activeProject) {
          await flushProjectModeAndOpen();
        }
      },
      onResetApiKey: async () => {
        await shutdownActiveServer();
        try {
          await keychain.deleteApiKey();
        } catch (err) {
          if (!(err instanceof KeychainUnsupportedError)) {
            void warn("keychain_delete_failed", fmtErr(err));
          }
        }
        sendToWebView(win, { type: "request-api-key" });
      },
      onOpenSignupUrl: () => {
        try {
          Electrobun.Utils.openExternal(SIGNUP_URL);
        } catch (err) {
          void logError("open_external_failed", fmtErr(err));
        }
      },
    },
    templateRoot,
    interviewHandlers,
  );

  win.webview.on("dom-ready", async () => {
    void log("webview_ready");
    let key: string | null = null;
    try {
      key = await keychain.getApiKey();
    } catch (err) {
      void logError("keychain_get_api_key_failed", fmtErr(err));
      sendToWebView(win, {
        type: "api-key-error",
        reason: "keychain",
        message: (err as Error).message,
      });
      return;
    }

    if (!key) {
      sendToWebView(win, { type: "request-api-key" });
      return;
    }

    // 2 回目以降: 起動だけ走らせ、検証 prompt は省略 (トークン節約)
    const ok = await startManagerWithKey(key, false);
    if (!ok) {
      sendToWebView(win, { type: "request-api-key" });
      return;
    }

    if (activeProject) {
      await flushProjectModeAndOpen();
    }
  });

  // before-quit は同期 emit (Node EventEmitter) で async は待たれない。
  // SIGTERM は async 関数の同期部分で送られるため、await せずに stop() を呼ぶ。
  // PreviewSync は SSE 購読を先に切ってから ChatBridge を dispose する順序を守る.
  Electrobun.events.on("before-quit", () => {
    void activePreviewSync?.stop();
    void activeBridge?.dispose();
    void activeManager?.stop();
  });

  // 保険: 万一 before-quit が emit されないパスでも SIGTERM を届ける.
  process.on("exit", () => {
    const info = activeManager?.getInfo();
    if (info) {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        // best-effort
      }
    }
  });
}

bootstrap();
