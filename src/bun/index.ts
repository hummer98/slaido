/**
 * メインプロセス（エントリポイント）
 *
 * BrowserWindow を起動し、WebView との `host-message` / `__SLAIDO_RECEIVE__` 通信骨格を提供する。
 * 起動前に opencode サーバを spawn し、ChatBridge を init してから projectStore を bootstrap、
 * 続けて activeSession を作成して BrowserWindow を表示する。
 * before-quit / process.exit 経由で opencode サーバと ChatBridge を停止させる。
 */

import Electrobun, { BrowserWindow } from "electrobun/bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

import { ChatBridge } from "./opencode/chat-bridge";
import type { ChatEvent } from "./opencode/types";
import { OpencodeServerManager } from "./opencode/server-manager";

const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("chat"), content: z.string() }),
  z.object({ type: z.literal("generate"), seedContent: z.string() }),
]);

type ClientMessage = z.infer<typeof ClientMessageSchema>;

type ServerMessage =
  | { type: "message"; role: "assistant"; content: string }
  | { type: "slides"; html: string }
  | { type: "open-slides"; url: string }
  | { type: "error"; message: string }
  | { type: "chat-event"; event: ChatEvent };

const opencodeManager = new OpencodeServerManager({
  extraEnv: process.env.OPENROUTER_API_KEY
    ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
    : undefined,
});
const chatBridge = new ChatBridge();

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
  activeSession: { sessionId: string } | null,
  seedContent: string,
): Promise<void> {
  if (!activeSession) {
    sendToWebView(win, { type: "error", message: "セッションが未初期化です" });
    return;
  }
  try {
    await chatBridge.sendMessage({
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
  activeSession: { sessionId: string } | null,
  userMessage: string,
): Promise<void> {
  if (!activeSession) {
    sendToWebView(win, { type: "error", message: "セッションが未初期化です" });
    return;
  }
  try {
    await chatBridge.sendMessage({
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

function attachHandlers(
  win: BrowserWindow,
  getActiveProject: () => Project | null,
  getActiveSession: () => { sessionId: string } | null,
): void {
  win.webview.on("dom-ready", () => {
    console.log("[slAIdo] WebView 準備完了");
    const activeProject = getActiveProject();
    if (activeProject) {
      const url = pathToFileURL(activeProject.slidesEntry).href;
      console.log(`[slAIdo] open-slides url=${url}`);
      sendToWebView(win, { type: "open-slides", url });
    }
  });

  win.on("host-message", (event: unknown) => {
    try {
      if (typeof event !== "object" || event === null) return;
      const data = (event as Record<string, unknown>).data;
      const parsed = ClientMessageSchema.safeParse(data);
      if (!parsed.success) return;

      const msg: ClientMessage = parsed.data;

      if (msg.type === "ready") {
        console.log("[slAIdo] クライアント接続");
        const activeProject = getActiveProject();
        if (activeProject) {
          const url = pathToFileURL(activeProject.slidesEntry).href;
          sendToWebView(win, { type: "open-slides", url });
        }
        return;
      }

      if (msg.type === "generate") {
        void generateSlides(win, getActiveSession(), msg.seedContent);
        return;
      }

      if (msg.type === "chat") {
        void refineSlides(win, getActiveSession(), msg.content);
        return;
      }
    } catch (err) {
      console.error("[slAIdo] host-message 処理失敗:", err);
    }
  });
}

async function bootstrap(): Promise<void> {
  let serverInfo;
  try {
    serverInfo = await opencodeManager.start();
  } catch (err) {
    console.error("[slAIdo] opencode 起動失敗:", err);
    process.exit(1);
  }

  try {
    await chatBridge.init({
      baseUrl: serverInfo.baseUrl,
      password: serverInfo.password,
      username: serverInfo.username,
    });
    console.log("[slAIdo] chat-bridge ready");
  } catch (err) {
    console.error("[slAIdo] chat-bridge 初期化失敗:", err);
    process.exit(1);
  }

  const projectsRoot = getProjectsRoot();
  const templateRoot = getBundledTemplateRoot();
  console.log(`[slAIdo] projectsRoot=${projectsRoot}`);
  console.log(`[slAIdo] templateRoot=${templateRoot}`);

  const store = new ProjectStore(projectsRoot, templateRoot);
  let activeProject: Project | null = null;
  let activeSession: { sessionId: string } | null = null;

  // bootstrap 順序を 1 並びに固定 (design-review 4-b)
  try {
    activeProject = await bootstrapProject(store);
    console.log(
      `[slAIdo] active project ${activeProject.meta.id} title="${activeProject.meta.title}" cwd=${activeProject.cwd}`,
    );
  } catch (err) {
    console.error("[slAIdo] bootstrap project failed:", err);
  }

  if (activeProject) {
    try {
      activeSession = await chatBridge.createSession({
        title: activeProject.meta.title,
      });
      console.log(`[slAIdo] active session ${activeSession.sessionId}`);
    } catch (err) {
      console.error("[slAIdo] createSession failed:", err);
      activeSession = null;
    }
  }

  const win = new BrowserWindow({
    title: "slAIdo",
    frame: { x: 0, y: 0, width: 1280, height: 800 },
    url: "views://mainview/index.html",
  });

  // ChatBridge の正規化イベントを WebView へそのまま転送 (T013 で UI mapping を本格化する前提)
  chatBridge.onEvent((ev) => {
    sendToWebView(win, { type: "chat-event", event: ev });
  });

  attachHandlers(win, () => activeProject, () => activeSession);

  // before-quit は同期 emit (Node EventEmitter) で async は待たれない。
  // SIGTERM は async 関数の同期部分で送られるため、await せずに stop() を呼ぶ。
  Electrobun.events.on("before-quit", () => {
    void chatBridge.dispose();
    void opencodeManager.stop();
  });

  // 保険: 万一 before-quit が emit されないパスでも SIGTERM を届ける.
  process.on("exit", () => {
    const info = opencodeManager.getInfo();
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
