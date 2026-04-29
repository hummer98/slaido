/**
 * メインプロセス（エントリポイント）
 *
 * BrowserWindow を起動し、WebView との `host-message` / `__SLAIDO_RECEIVE__` 通信骨格を提供する。
 * 起動前に opencode サーバを spawn し、最後に開いた or 新規プロジェクトを bootstrap して
 * iframe へ file:// URL でスライドを表示する。
 * before-quit / process.exit 経由で opencode サーバを停止させる。
 * LLM 連携は後続タスクで opencode + OpenRouter 経由で実装予定。
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
  | { type: "error"; message: string };

const opencodeManager = new OpencodeServerManager();

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

function generateSlides(win: BrowserWindow, _seedContent: string): void {
  // TODO(T009+): opencode SDK 経由で LLM を呼び出す
  sendToWebView(win, {
    type: "message",
    role: "assistant",
    content: "LLM 統合は未実装です。opencode + OpenRouter 連携を後続タスクで実装予定です。",
  });
}

function refineSlides(win: BrowserWindow, _userMessage: string): void {
  // TODO(T009+): opencode SDK 経由で LLM を呼び出す
  sendToWebView(win, {
    type: "message",
    role: "assistant",
    content: "LLM 統合は未実装です。",
  });
}

function attachHandlers(
  win: BrowserWindow,
  getActiveProject: () => Project | null,
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
        generateSlides(win, msg.seedContent);
        return;
      }

      if (msg.type === "chat") {
        refineSlides(win, msg.content);
        return;
      }
    } catch (err) {
      console.error("[slAIdo] host-message 処理失敗:", err);
    }
  });
}

async function bootstrap(): Promise<void> {
  try {
    await opencodeManager.start();
  } catch (err) {
    console.error("[slAIdo] opencode 起動失敗:", err);
    process.exit(1);
  }

  const projectsRoot = getProjectsRoot();
  const templateRoot = getBundledTemplateRoot();
  console.log(`[slAIdo] projectsRoot=${projectsRoot}`);
  console.log(`[slAIdo] templateRoot=${templateRoot}`);

  const store = new ProjectStore(projectsRoot, templateRoot);
  let activeProject: Project | null = null;

  bootstrapProject(store)
    .then((project) => {
      activeProject = project;
      console.log(
        `[slAIdo] active project ${project.meta.id} title="${project.meta.title}" cwd=${project.cwd}`,
      );
    })
    .catch((err) => {
      console.error("[slAIdo] bootstrap failed:", err);
    });

  const win = new BrowserWindow({
    title: "slAIdo",
    frame: { x: 0, y: 0, width: 1280, height: 800 },
    url: "views://mainview/index.html",
  });
  attachHandlers(win, () => activeProject);

  // before-quit は同期 emit (Node EventEmitter) で async は待たれない。
  // SIGTERM は async 関数の同期部分で送られるため、await せずに stop() を呼ぶ.
  Electrobun.events.on("before-quit", () => {
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
