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

import Electrobun, { BrowserWindow } from "electrobun/bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  getBundledTemplateRoot,
  getLastOpenedFile,
  getProjectsRoot,
} from "./storage/app-paths";
import { ProjectStore } from "./storage/project-store";
import { ProjectStoreError } from "./storage/types";
import type { Project } from "./storage/types";

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
import { PreviewSync } from "./preview/preview-sync";

const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("chat"), content: z.string() }),
  z.object({ type: z.literal("generate"), seedContent: z.string() }),
  z.object({
    type: z.literal("submit-api-key"),
    key: z.string().min(20).startsWith("sk-or-"),
  }),
  z.object({ type: z.literal("open-signup-url") }),
  z.object({ type: z.literal("reset-api-key") }),
]);

type ClientMessage = z.infer<typeof ClientMessageSchema>;

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
  | { type: "request-api-key" }
  | { type: "api-key-validated" }
  | { type: "api-key-error"; reason: ApiKeyErrorReason; message?: string };

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
    if (!parsed.success) return null;
    return { projectId: parsed.data.projectId };
  } catch {
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
        console.warn(
          `[slAIdo] last-opened project ${lastJson.projectId} is unavailable (${err.code}); creating new project`,
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

async function generateSlides(
  win: BrowserWindow,
  bridge: ChatBridge | null,
  activeSession: { sessionId: string } | null,
  seedContent: string,
): Promise<void> {
  if (!bridge || !activeSession) {
    sendToWebView(win, { type: "error", message: "セッションが未初期化です" });
    return;
  }
  try {
    await bridge.sendMessage({
      sessionId: activeSession.sessionId,
      parts: [
        {
          type: "text",
          text: `以下のシードドキュメントから reveal.js スライドを生成してください:\n\n${seedContent}`,
        },
      ],
    });
  } catch (err) {
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
  userMessage: string,
): Promise<void> {
  if (!bridge || !activeSession) {
    sendToWebView(win, { type: "error", message: "セッションが未初期化です" });
    return;
  }
  try {
    await bridge.sendMessage({
      sessionId: activeSession.sessionId,
      parts: [{ type: "text", text: userMessage }],
    });
  } catch (err) {
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
  sync.onUpdate(({ url }) => {
    sendToWebView(win, { type: "open-slides", url });
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

function attachHandlers(
  win: BrowserWindow,
  getActiveProject: () => Project | null,
  getActiveBridge: () => ChatBridge | null,
  getActiveSession: () => { sessionId: string } | null,
  apiKeyHandlers: ApiKeyHandlers,
): void {
  win.on("host-message", (event: unknown) => {
    try {
      if (typeof event !== "object" || event === null) return;
      const data = (event as Record<string, unknown>).data;
      const parsed = ClientMessageSchema.safeParse(data);
      if (!parsed.success) return;

      const msg: ClientMessage = parsed.data;

      if (msg.type === "ready") {
        console.log("[slAIdo] クライアント接続");
        return;
      }

      if (msg.type === "generate") {
        void generateSlides(win, getActiveBridge(), getActiveSession(), msg.seedContent);
        return;
      }

      if (msg.type === "chat") {
        void refineSlides(win, getActiveBridge(), getActiveSession(), msg.content);
        return;
      }

      if (msg.type === "submit-api-key") {
        void apiKeyHandlers.onSubmitApiKey(msg.key);
        return;
      }

      if (msg.type === "reset-api-key") {
        void apiKeyHandlers.onResetApiKey();
        return;
      }

      if (msg.type === "open-signup-url") {
        apiKeyHandlers.onOpenSignupUrl();
        return;
      }
    } catch (err) {
      console.error("[slAIdo] host-message 処理失敗:", err);
    }
  });
}

async function bootstrap(): Promise<void> {
  const projectsRoot = getProjectsRoot();
  const templateRoot = getBundledTemplateRoot();
  console.log(`[slAIdo] projectsRoot=${projectsRoot}`);
  console.log(`[slAIdo] templateRoot=${templateRoot}`);

  const store = new ProjectStore(projectsRoot, templateRoot);
  let activeProject: Project | null = null;
  let activeManager: OpencodeServerManager | null = null;
  let activeBridge: ChatBridge | null = null;
  let activeSession: { sessionId: string } | null = null;
  let activePreviewSync: PreviewSync | null = null;
  const keychain = new KeychainAdapter();

  const win = new BrowserWindow({
    title: "slAIdo",
    frame: { x: 0, y: 0, width: 1280, height: 800 },
    url: "views://mainview/index.html",
  });

  bootstrapProject(store)
    .then((project) => {
      activeProject = project;
      console.log(
        `[slAIdo] active project ${project.meta.id} title="${project.meta.title}" cwd=${project.cwd}`,
      );
      // 既に opencode が立ち上がっている場合、遅れてやってきた project を反映
      if (activeManager) {
        const url = pathToFileURL(project.slidesEntry).href;
        sendToWebView(win, { type: "open-slides", url });
      }
    })
    .catch((err) => {
      console.error("[slAIdo] bootstrap failed:", err);
    });

  /**
   * 既存の ChatBridge / Manager を停止する。再起動 (再入力 / 失敗ロールバック) で利用。
   */
  async function shutdownActiveServer(): Promise<void> {
    if (activePreviewSync) {
      try {
        await activePreviewSync.stop();
      } catch (err) {
        console.warn("[slAIdo] previous preview-sync stop failed:", err);
      }
      activePreviewSync = null;
    }
    if (activeBridge) {
      try {
        await activeBridge.dispose();
      } catch (err) {
        console.warn("[slAIdo] previous chat-bridge dispose failed:", err);
      }
      activeBridge = null;
    }
    activeSession = null;
    if (activeManager) {
      try {
        await activeManager.stop();
      } catch (err) {
        console.warn("[slAIdo] previous manager stop failed:", err);
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
      console.error("[slAIdo] opencode.json の配置に失敗:", err);
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
      console.error("[slAIdo] opencode start failed:", err);
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
        console.log(`[slAIdo] api key validated (key=${maskApiKey(key)})`);
      } catch (err) {
        const reason: ApiKeyErrorReason =
          err instanceof KeyValidationError ? err.reason : "unknown";
        const httpStatus =
          err instanceof KeyValidationError ? err.httpStatus : undefined;
        console.error(
          `[slAIdo] api key validation failed (key=${maskApiKey(key)}, httpStatus=${httpStatus ?? "n/a"}, reason=${reason}):`,
          err,
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
      sendToWebView(win, { type: "chat-event", event: ev });
    });
    try {
      await bridge.init({
        baseUrl: info.baseUrl,
        password: info.password,
        username: info.username,
      });
    } catch (err) {
      console.error("[slAIdo] chat-bridge 初期化失敗:", err);
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
    console.log("[slAIdo] chat-bridge ready");

    // active project があればセッションを作成
    if (activeProject) {
      try {
        activeSession = await bridge.createSession({
          title: activeProject.meta.title,
        });
        console.log(`[slAIdo] active session ${activeSession.sessionId}`);
      } catch (err) {
        console.error("[slAIdo] createSession failed:", err);
        activeSession = null;
      }
    }

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
        console.error("[slAIdo] PreviewSync start failed:", err);
        activePreviewSync = null;
      }
    }

    if (runValidation) {
      sendToWebView(win, { type: "api-key-validated" });
    } else {
      console.log(
        `[slAIdo] opencode ready (key=${maskApiKey(key)}, validation skipped)`,
      );
    }
    return true;
  }

  attachHandlers(
    win,
    () => activeProject,
    () => activeBridge,
    () => activeSession,
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
          const url = pathToFileURL(activeProject.slidesEntry).href;
          sendToWebView(win, { type: "open-slides", url });
        }
      },
      onResetApiKey: async () => {
        await shutdownActiveServer();
        try {
          await keychain.deleteApiKey();
        } catch (err) {
          if (!(err instanceof KeychainUnsupportedError)) {
            console.warn("[slAIdo] keychain delete failed:", err);
          }
        }
        sendToWebView(win, { type: "request-api-key" });
      },
      onOpenSignupUrl: () => {
        try {
          Electrobun.Utils.openExternal(SIGNUP_URL);
        } catch (err) {
          console.error("[slAIdo] openExternal failed:", err);
        }
      },
    },
  );

  win.webview.on("dom-ready", async () => {
    console.log("[slAIdo] WebView 準備完了");
    let key: string | null = null;
    try {
      key = await keychain.getApiKey();
    } catch (err) {
      console.error("[slAIdo] keychain getApiKey failed:", err);
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
      const url = pathToFileURL(activeProject.slidesEntry).href;
      sendToWebView(win, { type: "open-slides", url });
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
