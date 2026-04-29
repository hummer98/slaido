/**
 * メインプロセス（エントリポイント）
 *
 * BrowserWindow を起動し、WebView との `host-message` / `__SLAIDO_RECEIVE__` 通信骨格を提供する。
 * LLM 連携は後続タスクで opencode + OpenRouter 経由で実装予定。
 */

import { BrowserWindow } from "electrobun/bun";
import { z } from "zod";

const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("chat"), content: z.string() }),
  z.object({ type: z.literal("generate"), seedContent: z.string() }),
]);

type ClientMessage = z.infer<typeof ClientMessageSchema>;

type ServerMessage =
  | { type: "message"; role: "assistant"; content: string }
  | { type: "slides"; html: string }
  | { type: "error"; message: string };

const win = new BrowserWindow({
  title: "slAIdo",
  frame: {
    width: 1280,
    height: 800,
  },
  url: "views://mainview/index.html",
});

/**
 * WebView にメッセージを送信する。
 */
function sendToWebView(msg: ServerMessage): void {
  win.webview.executeJavascript(
    `window.__SLAIDO_RECEIVE__(${JSON.stringify(msg)})`
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

win.webview.on("dom-ready", () => {
  console.log("[slAIdo] WebView 準備完了");
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
