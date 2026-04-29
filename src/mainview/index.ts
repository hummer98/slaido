/**
 * WebView レンダラー
 *
 * チャット UI の操作とメインプロセスとの通信を管理する。
 * メインプロセスへのメッセージ送信は __electrobunSendToHost() を使用する。
 */

declare function __electrobunSendToHost(data: unknown): void;

type ServerMessage =
  | { type: "message"; role: "assistant"; content: string }
  | { type: "slides"; html: string }
  | { type: "open-slides"; url: string }
  | { type: "error"; message: string };

const chatMessages = document.getElementById("chat-messages") as HTMLDivElement;
const seedInput = document.getElementById("seed-input") as HTMLTextAreaElement;
const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const previewIframe = document.getElementById("preview-iframe") as HTMLIFrameElement;
const previewEmpty = document.getElementById("preview-empty") as HTMLDivElement;
const previewStatus = document.getElementById("preview-status") as HTMLSpanElement;

let isGenerating = false;

/**
 * チャットメッセージを表示する。
 */
function appendMessage(role: "user" | "assistant" | "error", content: string): void {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = content;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * スライドプレビューを srcdoc で更新する（旧経路。T012 で chokidar に倒れた場合の予備）。
 */
function updatePreview(html: string): void {
  previewEmpty.style.display = "none";
  previewIframe.style.display = "block";
  previewIframe.removeAttribute("src");
  previewIframe.srcdoc = html;
  previewStatus.textContent = "生成済み";
}

/**
 * スライドプレビューを file:// or http:// URL で更新する。
 */
function openSlidesUrl(url: string): void {
  previewEmpty.style.display = "none";
  previewIframe.style.display = "block";
  previewIframe.removeAttribute("srcdoc");
  previewIframe.src = url;
  previewStatus.textContent = "テンプレ表示中";
}

/**
 * メインプロセスからのメッセージを受信する。
 */
window.__SLAIDO_RECEIVE__ = (msg: ServerMessage): void => {
  if (msg.type === "message") {
    appendMessage("assistant", msg.content);
    setGenerating(false);
    return;
  }

  if (msg.type === "slides") {
    updatePreview(msg.html);
    return;
  }

  if (msg.type === "open-slides") {
    openSlidesUrl(msg.url);
    return;
  }

  if (msg.type === "error") {
    appendMessage("error", msg.content ?? msg.message);
    setGenerating(false);
    return;
  }
};

function setGenerating(value: boolean): void {
  isGenerating = value;
  generateBtn.disabled = value;
  sendBtn.disabled = value;
  generateBtn.textContent = value ? "生成中..." : "スライドを生成";
}

generateBtn.addEventListener("click", () => {
  const seedContent = seedInput.value.trim();
  if (!seedContent || isGenerating) return;

  appendMessage("user", `[ドキュメントからスライドを生成]`);
  setGenerating(true);
  previewStatus.textContent = "生成中...";

  __electrobunSendToHost({ type: "generate", seedContent });
});

sendBtn.addEventListener("click", () => {
  sendChatMessage();
});

chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

function sendChatMessage(): void {
  const content = chatInput.value.trim();
  if (!content || isGenerating) return;

  appendMessage("user", content);
  chatInput.value = "";
  setGenerating(true);

  __electrobunSendToHost({ type: "chat", content });
}

// メインプロセスに準備完了を通知
__electrobunSendToHost({ type: "ready" });

// グローバルに公開（メインプロセスから executeJavascript で呼び出せるように）
declare global {
  interface Window {
    __SLAIDO_RECEIVE__: (msg: ServerMessage) => void;
  }
}
