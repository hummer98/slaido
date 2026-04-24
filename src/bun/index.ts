/**
 * メインプロセス（エントリポイント）
 *
 * BrowserWindow を起動し、WebView との WebSocket 通信を管理する。
 * ユーザーのチャット入力を受け取り、Claude API でスライド HTML を生成して返す。
 */

import { BrowserWindow } from "electrobun/bun";
import Anthropic from "@anthropic-ai/sdk";
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

const anthropic = new Anthropic();

const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

let currentSlidesHtml = "";

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

/**
 * シードドキュメントからスライドを生成する。
 */
async function generateSlides(seedContent: string): Promise<void> {
  const systemPrompt = `あなたはプレゼンテーションスライドの専門家です。
ユーザーが提供するドキュメントやアウトラインをもとに、reveal.js 形式の HTML スライドを生成します。

## 出力形式

reveal.js を CDN から読み込む完全な HTML ファイルを出力してください。
\`\`\`html
<!DOCTYPE html>
<html>
...
</html>
\`\`\`

## スライド設計の原則

- 1 スライド = 1 メッセージ（情報の詰め込みすぎを避ける）
- タイトルスライド + 本編 + まとめで構成する
- 図やリストを活用して視覚的にわかりやすくする
- テーマは black を使用する

## reveal.js の基本構造

\`\`\`html
<div class="reveal">
  <div class="slides">
    <section>スライド1</section>
    <section>スライド2</section>
  </div>
</div>
\`\`\`

HTML コードブロックのみを返してください。説明文は不要です。`;

  const userMessage = `以下のドキュメントをもとにプレゼンテーションスライドを作成してください:\n\n${seedContent}`;

  conversationHistory.push({ role: "user", content: userMessage });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      messages: conversationHistory,
    });

    const assistantContent = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    conversationHistory.push({ role: "assistant", content: assistantContent });

    // HTML コードブロックを抽出
    const htmlMatch = assistantContent.match(/```html\n([\s\S]*?)\n```/);
    if (htmlMatch) {
      currentSlidesHtml = htmlMatch[1];
      sendToWebView({ type: "slides", html: currentSlidesHtml });
      sendToWebView({ type: "message", role: "assistant", content: "スライドを生成しました。修正したい箇所があればお知らせください。" });
    } else {
      // コードブロックなしで HTML 全体が返ってきた場合
      currentSlidesHtml = assistantContent;
      sendToWebView({ type: "slides", html: currentSlidesHtml });
      sendToWebView({ type: "message", role: "assistant", content: "スライドを生成しました。修正したい箇所があればお知らせください。" });
    }
  } catch (err) {
    console.error("[slAIdo] スライド生成失敗:", err);
    sendToWebView({ type: "error", message: `生成に失敗しました: ${String(err)}` });
  }
}

/**
 * チャットでスライドを修正する。
 */
async function refineSlides(userMessage: string): Promise<void> {
  const contextMessage = currentSlidesHtml
    ? `現在のスライド HTML:\n\`\`\`html\n${currentSlidesHtml}\n\`\`\`\n\nユーザーの要望: ${userMessage}`
    : userMessage;

  conversationHistory.push({ role: "user", content: contextMessage });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: conversationHistory,
    });

    const assistantContent = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    conversationHistory.push({ role: "assistant", content: assistantContent });

    const htmlMatch = assistantContent.match(/```html\n([\s\S]*?)\n```/);
    if (htmlMatch) {
      currentSlidesHtml = htmlMatch[1];
      sendToWebView({ type: "slides", html: currentSlidesHtml });
      sendToWebView({ type: "message", role: "assistant", content: "スライドを更新しました。" });
    } else {
      // HTML が含まれない応答（質問への回答など）
      sendToWebView({ type: "message", role: "assistant", content: assistantContent });
    }
  } catch (err) {
    console.error("[slAIdo] スライド修正失敗:", err);
    sendToWebView({ type: "error", message: `修正に失敗しました: ${String(err)}` });
  }
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
      void generateSlides(msg.seedContent);
      return;
    }

    if (msg.type === "chat") {
      void refineSlides(msg.content);
      return;
    }
  } catch (err) {
    console.error("[slAIdo] host-message 処理失敗:", err);
  }
});
