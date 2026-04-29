/**
 * WebView レンダラー
 *
 * チャット UI の操作とメインプロセスとの通信を管理する。
 * メインプロセスへのメッセージ送信は __electrobunSendToHost() を使用する。
 */

declare function __electrobunSendToHost(data: unknown): void;

type ChatEventMin =
  | {
      type: "text-chunk";
      sessionId: string;
      messageId: string;
      partId: string;
      text: string;
      delta?: string;
    }
  | {
      type: "reasoning-chunk";
      sessionId: string;
      messageId: string;
      partId: string;
      text: string;
      delta?: string;
    }
  | { type: "step-finish"; sessionId: string; messageId: string }
  | { type: "error"; sessionId?: string; reason: string }
  | { type: string; [k: string]: unknown };

type ApiKeyErrorReason =
  | "unauthorized"
  | "rate_limit"
  | "network"
  | "keychain"
  | "startup"
  | "unknown";

type ExportKind = "pdf" | "html-zip";
type ExportPhase = "start" | "done" | "error" | "canceled";

type ExportProgressMessage = {
  type: "export-progress";
  kind: ExportKind;
  phase: ExportPhase;
  message?: string;
  category?: string;
  silent?: boolean;
};

type ServerMessage =
  | { type: "message"; role: "assistant"; content: string }
  | { type: "slides"; html: string }
  | { type: "open-slides"; url: string }
  | { type: "error"; message: string }
  | { type: "chat-event"; event: ChatEventMin }
  | { type: "request-api-key" }
  | { type: "api-key-validated" }
  | { type: "api-key-error"; reason: ApiKeyErrorReason; message?: string }
  | ExportProgressMessage;

declare global {
  interface Window {
    __SLAIDO_RECEIVE__: (msg: ServerMessage) => void;
  }
}

const chatMessages = document.getElementById("chat-messages") as HTMLDivElement;
const seedInput = document.getElementById("seed-input") as HTMLTextAreaElement;
const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const previewIframe = document.getElementById("preview-iframe") as HTMLIFrameElement;
const previewEmpty = document.getElementById("preview-empty") as HTMLDivElement;
const previewStatus = document.getElementById("preview-status") as HTMLSpanElement;

const apiKeyModal = document.getElementById("api-key-modal") as HTMLDivElement;
const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement;
const apiKeyError = document.getElementById("api-key-error") as HTMLDivElement;
const apiKeySubmitBtn = document.getElementById("api-key-submit-btn") as HTMLButtonElement;
const apiKeySignupBtn = document.getElementById("api-key-signup-btn") as HTMLButtonElement;
const apiKeyResetLink = document.getElementById("api-key-reset-link") as HTMLButtonElement;

const exportPdfBtn = document.getElementById("export-pdf-btn") as HTMLButtonElement;
const exportHtmlZipBtn = document.getElementById("export-html-zip-btn") as HTMLButtonElement;

const EXPORT_LABELS: Record<ExportKind, { idle: string; running: string }> = {
  pdf: { idle: "PDF として保存", running: "PDF 作成中..." },
  "html-zip": { idle: "HTML として書き出し", running: "ZIP 作成中..." },
};

function getExportButton(kind: ExportKind): HTMLButtonElement {
  return kind === "pdf" ? exportPdfBtn : exportHtmlZipBtn;
}

function setExportRunning(kind: ExportKind, running: boolean): void {
  const btn = getExportButton(kind);
  btn.disabled = running;
  btn.textContent = running ? EXPORT_LABELS[kind].running : EXPORT_LABELS[kind].idle;
}

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

// T009 暫定: text-chunk の messageId 単位でアシスタント DOM を 1 つだけ作り、
// 累積テキストを差し替える (T013 で本格 mapping に置換)
const assistantMessageNodes = new Map<string, HTMLDivElement>();

function applyTextChunk(messageId: string, text: string, role: "assistant"): void {
  let div = assistantMessageNodes.get(messageId);
  if (!div) {
    div = document.createElement("div");
    div.className = `message ${role}`;
    chatMessages.appendChild(div);
    assistantMessageNodes.set(messageId, div);
  }
  div.textContent = text;
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
 * 入力値が API キーとして妥当かを判定する (main 側 zod と同条件、plan F5).
 */
function isValidApiKeyInput(value: string): boolean {
  return value.length >= 20 && value.startsWith("sk-or-");
}

/**
 * モーダル表示中はチャット入力を無効化する。
 */
function setChatDisabled(disabled: boolean): void {
  seedInput.disabled = disabled;
  chatInput.disabled = disabled;
  generateBtn.disabled = disabled || isGenerating;
  sendBtn.disabled = disabled || isGenerating;
}

function showApiKeyModal(): void {
  apiKeyModal.classList.remove("hidden");
  apiKeyModal.setAttribute("aria-hidden", "false");
  apiKeyError.classList.add("hidden");
  apiKeyError.textContent = "";
  apiKeyInput.value = "";
  apiKeySubmitBtn.disabled = true;
  setChatDisabled(true);
  // 表示直後にフォーカス
  setTimeout(() => apiKeyInput.focus(), 0);
}

function hideApiKeyModal(): void {
  apiKeyModal.classList.add("hidden");
  apiKeyModal.setAttribute("aria-hidden", "true");
  apiKeyError.classList.add("hidden");
  apiKeyError.textContent = "";
  apiKeyInput.value = "";
  setChatDisabled(false);
}

function showApiKeyError(reason: ApiKeyErrorReason, message?: string): void {
  const text =
    {
      unauthorized: "API キーが無効です。",
      rate_limit: "OpenRouter のレート制限に達しました。少し待ってからやり直してください。",
      network: "OpenRouter への通信に失敗しました。ネットワーク状況を確認してください。",
      keychain: "Keychain への保存に失敗しました。",
      startup: "opencode サーバの起動に失敗しました。",
      unknown: "不明なエラーが発生しました。",
    }[reason] ?? "不明なエラーが発生しました。";

  apiKeyError.textContent = message ? `${text} (${message})` : text;
  apiKeyError.classList.remove("hidden");
  apiKeyInput.focus();
  apiKeyInput.select();
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
    appendMessage("error", msg.message);
    setGenerating(false);
    return;
  }

  if (msg.type === "chat-event") {
    const ev = msg.event;
    if (ev.type === "text-chunk") {
      const text = (ev as { text?: string }).text ?? "";
      const messageId = (ev as { messageId?: string }).messageId ?? "default";
      applyTextChunk(messageId, text, "assistant");
      return;
    }
    if (ev.type === "step-finish") {
      setGenerating(false);
      return;
    }
    if (ev.type === "error") {
      const reason = (ev as { reason?: string }).reason ?? "unknown";
      appendMessage("error", `[chat-event:error] ${reason}`);
      setGenerating(false);
      return;
    }
    // raw / reasoning-chunk / tool-status / permission-request は T013 で UI 化
    return;
  }

  if (msg.type === "request-api-key") {
    showApiKeyModal();
    return;
  }

  if (msg.type === "api-key-validated") {
    hideApiKeyModal();
    return;
  }

  if (msg.type === "api-key-error") {
    showApiKeyError(msg.reason, msg.message);
    return;
  }

  if (msg.type === "export-progress") {
    handleExportProgress(msg);
    return;
  }
};

function handleExportProgress(msg: ExportProgressMessage): void {
  if (msg.phase === "start") {
    setExportRunning(msg.kind, true);
    return;
  }
  // done / error / canceled いずれもボタンは復帰
  setExportRunning(msg.kind, false);
  if (msg.phase === "error" && !msg.silent && msg.message) {
    appendMessage("error", `[export:${msg.kind}] ${msg.message}`);
  }
}

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

// API キーモーダルの結線
apiKeyInput.addEventListener("input", () => {
  const value = apiKeyInput.value.trim();
  apiKeySubmitBtn.disabled = !isValidApiKeyInput(value);
  if (!apiKeyError.classList.contains("hidden")) {
    apiKeyError.classList.add("hidden");
    apiKeyError.textContent = "";
  }
});

apiKeyInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (!apiKeySubmitBtn.disabled) {
      submitApiKey();
    }
  }
});

apiKeySubmitBtn.addEventListener("click", () => {
  submitApiKey();
});

apiKeySignupBtn.addEventListener("click", () => {
  __electrobunSendToHost({ type: "open-signup-url" });
});

apiKeyResetLink.addEventListener("click", (ev) => {
  ev.preventDefault();
  __electrobunSendToHost({ type: "reset-api-key" });
});

function submitApiKey(): void {
  const value = apiKeyInput.value.trim();
  if (!isValidApiKeyInput(value)) return;
  apiKeySubmitBtn.disabled = true;
  apiKeyError.classList.add("hidden");
  apiKeyError.textContent = "";
  __electrobunSendToHost({ type: "submit-api-key", key: value });
}

exportPdfBtn.addEventListener("click", () => {
  if (exportPdfBtn.disabled) return;
  __electrobunSendToHost({ type: "export-pdf" });
});

exportHtmlZipBtn.addEventListener("click", () => {
  if (exportHtmlZipBtn.disabled) return;
  __electrobunSendToHost({ type: "export-html-zip" });
});

// メインプロセスに準備完了を通知
__electrobunSendToHost({ type: "ready" });

// このファイルをモジュールとして扱わせ、`declare global` を有効化する。
export {};
