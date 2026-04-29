/**
 * メインプロセス（エントリポイント）
 *
 * BrowserWindow を起動し、WebView との `host-message` / `__SLAIDO_RECEIVE__` 通信骨格を提供する。
 * 起動時に「最後に開いたプロジェクト」or 新規プロジェクトを bootstrap し、
 * iframe へ file:// URL でスライドを表示する。
 */

import { BrowserWindow } from "electrobun/bun";
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

const win = new BrowserWindow({
  title: "slAIdo",
  frame: {
    width: 1280,
    height: 800,
  },
  url: "views://mainview/index.html",
});

function sendToWebView(msg: ServerMessage): void {
  win.webview.executeJavascript(
    `window.__SLAIDO_RECEIVE__(${JSON.stringify(msg)})`,
  );
}

function generateSlides(_seedContent: string): void {
  // TODO(task-008+): opencode + OpenRouter 経由で LLM を呼び出す
  sendToWebView({
    type: "message",
    role: "assistant",
    content: "LLM 統合は未実装です。opencode + OpenRouter 連携を後続タスクで実装予定です。",
  });
}

function refineSlides(_userMessage: string): void {
  // TODO(task-008+): opencode + OpenRouter 経由で LLM を呼び出す
  sendToWebView({
    type: "message",
    role: "assistant",
    content: "LLM 統合は未実装です。",
  });
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

win.webview.on("dom-ready", () => {
  console.log("[slAIdo] WebView 準備完了");
  if (activeProject) {
    const url = pathToFileURL(activeProject.slidesEntry).href;
    console.log(`[slAIdo] open-slides url=${url}`);
    sendToWebView({ type: "open-slides", url });
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
      if (activeProject) {
        const url = pathToFileURL(activeProject.slidesEntry).href;
        sendToWebView({ type: "open-slides", url });
      }
      return;
    }

    if (msg.type === "generate") {
      generateSlides(msg.seedContent);
      return;
    }

    if (msg.type === "chat") {
      refineSlides(msg.content);
      return;
    }
  } catch (err) {
    console.error("[slAIdo] host-message 処理失敗:", err);
  }
});
