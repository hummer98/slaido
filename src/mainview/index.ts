/**
 * WebView レンダラー
 *
 * チャット UI の操作とメインプロセスとの通信を管理する.
 * pure 状態遷移は `state.ts` の reducer に委譲し、ここでは IPC と DOM 反映のみ扱う.
 *
 * メインプロセスへのメッセージ送信は __electrobunSendToHost() を使用する.
 */

declare function __electrobunSendToHost(data: unknown): void;

// E2E ブリッジ用: bun-mot は browser 側で `Electroview` を構築して RPC transport を確立し、
// builtin の `evaluateJavascriptWithResponse` extraRequestHandler を登録することを前提とする。
// slaido は通常運用では __electrobunSendToHost のみで成立しているが、bun-mot を動かすにはこの初期化が必要。
import { Electroview } from "electrobun/view";
new Electroview({
  rpc: Electroview.defineRPC({ handlers: { requests: {}, messages: {} } }),
});

import type { ChatEvent } from "../bun/opencode";
import {
  initialState,
  reduce,
  toolLabel,
  type Action,
  type ChatLogState,
  type MessageNode,
  type PermissionPrompt,
} from "./state";

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
  | { type: "chat-event"; event: ChatEvent }
  | { type: "project-mode"; mode: "seed" | "chat" }
  | { type: "request-api-key" }
  | { type: "api-key-validated" }
  | { type: "api-key-error"; reason: ApiKeyErrorReason; message?: string }
  | ExportProgressMessage;

declare global {
  interface Window {
    __SLAIDO_RECEIVE__: (msg: ServerMessage) => void;
    __SLAIDO_DEV__?: boolean;
  }
}

const chatMessages = document.getElementById("chat-messages") as HTMLDivElement;
const seedInput = document.getElementById("seed-input") as HTMLTextAreaElement;
const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const abortBtn = document.getElementById("abort-btn") as HTMLButtonElement;
const previewIframe = document.getElementById("preview-iframe") as HTMLIFrameElement;
const previewEmpty = document.getElementById("preview-empty") as HTMLDivElement;
const previewStatus = document.getElementById("preview-status") as HTMLSpanElement;
const devRawTrailList = document.getElementById("dev-raw-trail-list") as HTMLDivElement;

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

let state: ChatLogState = initialState();
let pendingFrame = false;
let dirty = true;
let lastRenderedRawCount = 0;

function dispatch(action: Action): void {
  state = reduce(state, action);
  scheduleRender();
}

function scheduleRender(): void {
  dirty = true;
  if (pendingFrame) return;
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    if (!dirty) return;
    dirty = false;
    render();
  });
}

function render(): void {
  applySeedModeClass();
  renderMessages();
  renderInputArea();
  if (isDevMode()) {
    renderDevRawTrail();
  }
}

function applySeedModeClass(): void {
  const mode =
    state.seedMode === null ? "loading" : state.seedMode ? "seed" : "chat";
  document.body.dataset["seedMode"] = mode;
}

function renderInputArea(): void {
  if (state.turn === "running") {
    sendBtn.hidden = true;
    abortBtn.hidden = false;
    abortBtn.disabled = false;
    abortBtn.textContent = "中断";
    chatInput.disabled = true;
    generateBtn.disabled = true;
  } else if (state.turn === "aborting") {
    sendBtn.hidden = true;
    abortBtn.hidden = false;
    abortBtn.disabled = true;
    abortBtn.textContent = "中断中…";
    chatInput.disabled = true;
    generateBtn.disabled = true;
  } else {
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    chatInput.disabled = false;
    generateBtn.disabled = false;
    sendBtn.textContent = "送信";
    generateBtn.textContent = "スライドを生成";
  }
}

/**
 * 既存 DOM と state.messages を比較し、差分のみ更新する.
 * `<details>` の開閉状態を保つため innerHTML 一括置換は使わない.
 */
function renderMessages(): void {
  const seenIds = new Set<string>();

  const renderTargets: Array<{ id: string; node: MessageNode | null; permission: PermissionPrompt | null }> = [];
  for (const msg of state.messages) {
    renderTargets.push({ id: `msg:${msg.id}`, node: msg, permission: null });
  }
  for (const perm of state.permissions) {
    renderTargets.push({ id: `perm:${perm.permissionId}`, node: null, permission: perm });
  }

  // 既存の child を id でインデックス化
  const existingNodes = new Map<string, HTMLElement>();
  for (const child of Array.from(chatMessages.children)) {
    if (child instanceof HTMLElement) {
      const id = child.dataset["entryId"];
      if (id) existingNodes.set(id, child);
    }
  }

  for (const target of renderTargets) {
    seenIds.add(target.id);
    let el = existingNodes.get(target.id);
    if (!el) {
      el = document.createElement("div");
      el.dataset["entryId"] = target.id;
      chatMessages.appendChild(el);
    }
    if (target.node) {
      renderMessageNode(el, target.node);
    } else if (target.permission) {
      renderPermissionPrompt(el, target.permission);
    }
  }

  // 余剰 node を削除
  for (const [id, el] of existingNodes) {
    if (!seenIds.has(id)) {
      el.remove();
    }
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderMessageNode(el: HTMLElement, msg: MessageNode): void {
  el.className = `message ${msg.role}`;
  // 既存ブロックを id でインデックス化
  const existingBlocks = new Map<string, HTMLElement>();
  for (const child of Array.from(el.children)) {
    if (child instanceof HTMLElement) {
      const id = child.dataset["blockId"];
      if (id) existingBlocks.set(id, child);
    }
  }

  if (msg.role === "user") {
    el.textContent = "";
    const text = msg.blocks
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("");
    el.textContent = text;
    return;
  }

  if (msg.role === "error") {
    const text = msg.blocks
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("");
    el.textContent = text;
    if (!el.querySelector(".retry-btn")) {
      const btn = document.createElement("button");
      btn.className = "retry-btn";
      btn.type = "button";
      btn.textContent = "再試行";
      btn.addEventListener("click", () => {
        dispatch({ type: "retry-last" });
        const text = state.lastUserInput;
        if (text !== null && text !== "") {
          __electrobunSendToHost({ type: "chat", content: text });
        }
      });
      el.appendChild(btn);
    }
    return;
  }

  // assistant: blocks を順序通りに反映
  const seenBlocks = new Set<string>();
  let prev: HTMLElement | null = null;
  for (const block of msg.blocks) {
    let blockId: string;
    if (block.kind === "text") blockId = `text:${block.partId}`;
    else if (block.kind === "reasoning") blockId = `reasoning:${block.partId}`;
    else blockId = `tool:${block.callId}`;
    seenBlocks.add(blockId);

    let blockEl = existingBlocks.get(blockId);
    if (!blockEl) {
      blockEl = document.createElement("div");
      blockEl.dataset["blockId"] = blockId;
    }
    if (block.kind === "text") {
      if (blockEl.tagName !== "DIV") {
        const replacement = document.createElement("div");
        replacement.dataset["blockId"] = blockId;
        blockEl.replaceWith(replacement);
        blockEl = replacement;
      }
      blockEl.className = "block-text";
      blockEl.textContent = block.text;
    } else if (block.kind === "reasoning") {
      if (blockEl.tagName !== "DETAILS") {
        const replacement = document.createElement("details");
        replacement.dataset["blockId"] = blockId;
        // 初回作成時のみ open 属性を確定 (それ以降はユーザー操作を尊重)
        if (!block.collapsed) replacement.open = true;
        blockEl.replaceWith(replacement);
        blockEl = replacement;
      }
      blockEl.className = "block-reasoning";
      let summary = blockEl.querySelector("summary");
      if (!summary) {
        summary = document.createElement("summary");
        summary.textContent = "思考";
        blockEl.appendChild(summary);
      }
      let textEl = blockEl.querySelector(".reasoning-text") as HTMLDivElement | null;
      if (!textEl) {
        textEl = document.createElement("div");
        textEl.className = "reasoning-text";
        blockEl.appendChild(textEl);
      }
      textEl.textContent = block.text;
    } else {
      if (blockEl.tagName !== "DIV") {
        const replacement = document.createElement("div");
        replacement.dataset["blockId"] = blockId;
        blockEl.replaceWith(replacement);
        blockEl = replacement;
      }
      blockEl.className = "block-tool-status";
      blockEl.dataset["state"] = block.state;
      blockEl.setAttribute("role", "status");
      blockEl.textContent =
        block.state === "completed" ? `${block.label} (完了)` : block.label;
    }

    // 順序: prev の直後に挿入
    if (prev) {
      if (prev.nextElementSibling !== blockEl) {
        prev.insertAdjacentElement("afterend", blockEl);
      }
    } else {
      if (el.firstElementChild !== blockEl) {
        el.insertBefore(blockEl, el.firstElementChild);
      }
    }
    prev = blockEl;
  }

  // 余剰 block を削除
  for (const [id, blockEl] of existingBlocks) {
    if (!seenBlocks.has(id)) blockEl.remove();
  }
}

function renderPermissionPrompt(el: HTMLElement, prompt: PermissionPrompt): void {
  el.className = "permission-prompt";
  el.dataset["status"] = prompt.status;
  el.dataset["permissionId"] = prompt.permissionId;

  if (prompt.status === "auto-allowed") {
    el.className = "auto-permission-log";
    el.textContent = `[自動許可] ${prompt.kind}: ${prompt.title}`;
    return;
  }

  // pending / user-allowed / user-denied は同じ DOM 構造で出す
  let title = el.querySelector(".permission-prompt-title") as HTMLDivElement | null;
  if (!title) {
    title = document.createElement("div");
    title.className = "permission-prompt-title";
    el.appendChild(title);
  }
  title.textContent =
    prompt.status === "user-allowed"
      ? `[許可済み] ${prompt.title}`
      : prompt.status === "user-denied"
        ? `[拒否済み] ${prompt.title}`
        : `${prompt.title} を実行してもよいですか？`;

  let actions = el.querySelector(".permission-prompt-actions") as HTMLDivElement | null;
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "permission-prompt-actions";
    const allow = document.createElement("button");
    allow.dataset["action"] = "allow";
    allow.type = "button";
    allow.textContent = "許可";
    allow.addEventListener("click", () => {
      const id = el.dataset["permissionId"];
      if (id) dispatch({ type: "permission-decide", permissionId: id, allow: true });
    });
    const deny = document.createElement("button");
    deny.dataset["action"] = "deny";
    deny.type = "button";
    deny.textContent = "拒否";
    deny.addEventListener("click", () => {
      const id = el.dataset["permissionId"];
      if (id) dispatch({ type: "permission-decide", permissionId: id, allow: false });
    });
    actions.appendChild(allow);
    actions.appendChild(deny);
    el.appendChild(actions);
  }
  // ボタンの活性は status で切替
  const buttons = actions.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((btn) => {
    btn.disabled = prompt.status !== "pending";
  });
}

function renderDevRawTrail(): void {
  if (!devRawTrailList) return;
  // 増分のみ追加 (rawTrail は append-only)
  for (let i = lastRenderedRawCount; i < state.rawTrail.length; i++) {
    const ev = state.rawTrail[i];
    if (!ev) continue;
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = ev.type;
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(ev, null, 2);
    det.appendChild(sum);
    det.appendChild(pre);
    devRawTrailList.appendChild(det);
  }
  lastRenderedRawCount = state.rawTrail.length;
}

/**
 * 開発モード判定 (R-4): クエリ + localStorage + window グローバルの OR.
 * `import.meta.env.DEV` は Electrobun の views ビルド系で通るか未確認のため採用見送り.
 */
function isDevMode(): boolean {
  try {
    if (window.__SLAIDO_DEV__ === true) return true;
    const params = new URLSearchParams(window.location.search);
    if (params.get("dev") === "1") return true;
    if (window.localStorage?.getItem("slaido_dev") === "1") return true;
  } catch {
    // ignore (sandbox 等)
  }
  return false;
}

function applyDevModeAttribute(): void {
  document.body.dataset["dev"] = isDevMode() ? "1" : "0";
}

/**
 * スライドプレビューを srcdoc で更新する（旧経路。T012 で chokidar に倒れた場合の予備）.
 */
function updatePreview(html: string): void {
  previewEmpty.style.display = "none";
  previewIframe.style.display = "block";
  previewIframe.removeAttribute("src");
  previewIframe.srcdoc = html;
  previewStatus.textContent = "生成済み";
}

function openSlidesUrl(url: string): void {
  previewEmpty.style.display = "none";
  previewIframe.style.display = "block";
  previewIframe.removeAttribute("srcdoc");
  previewIframe.src = url;
  previewStatus.textContent = "テンプレ表示中";
}

function isValidApiKeyInput(value: string): boolean {
  return value.length >= 20 && value.startsWith("sk-or-");
}

function setChatInputsDisabled(disabled: boolean): void {
  seedInput.disabled = disabled;
  chatInput.disabled = disabled;
  generateBtn.disabled = disabled;
  sendBtn.disabled = disabled;
}

function showApiKeyModal(): void {
  apiKeyModal.classList.remove("hidden");
  apiKeyModal.setAttribute("aria-hidden", "false");
  apiKeyError.classList.add("hidden");
  apiKeyError.textContent = "";
  apiKeyInput.value = "";
  apiKeySubmitBtn.disabled = true;
  setChatInputsDisabled(true);
  setTimeout(() => apiKeyInput.focus(), 0);
}

function hideApiKeyModal(): void {
  apiKeyModal.classList.add("hidden");
  apiKeyModal.setAttribute("aria-hidden", "true");
  apiKeyError.classList.add("hidden");
  apiKeyError.textContent = "";
  apiKeyInput.value = "";
  setChatInputsDisabled(false);
  // turn 状態に応じて再描画
  scheduleRender();
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

window.__SLAIDO_RECEIVE__ = (msg: ServerMessage): void => {
  if (msg.type === "slides") {
    updatePreview(msg.html);
    return;
  }

  if (msg.type === "open-slides") {
    openSlidesUrl(msg.url);
    return;
  }

  if (msg.type === "project-mode") {
    dispatch({ type: "set-seed-mode", mode: msg.mode });
    return;
  }

  if (msg.type === "message") {
    // legacy: appendMessage 経路は最低限のメッセージのみ
    const node: MessageNode = {
      id: `legacy-${Date.now()}`,
      role: "assistant",
      blocks: [{ kind: "text", partId: "legacy", text: msg.content }],
      createdAt: Date.now(),
    };
    state = {
      ...state,
      messages: [...state.messages, node],
      turn: "idle",
    };
    scheduleRender();
    return;
  }

  if (msg.type === "error") {
    const node: MessageNode = {
      id: `legacy-err-${Date.now()}`,
      role: "error",
      blocks: [{ kind: "text", partId: "legacy", text: msg.message }],
      createdAt: Date.now(),
    };
    state = {
      ...state,
      messages: [...state.messages, node],
      turn: "idle",
    };
    scheduleRender();
    return;
  }

  if (msg.type === "chat-event") {
    dispatch({ type: "chat-event", event: msg.event });
    // ヘッダー (preview-status) にも進行中ツールを表示する。
    // 長い tool chain (Read → Read → Write …) の最中も「生成中...」固定だと
    // ユーザは止まっているように見えるので、現在のツールでアップデートする。
    updatePreviewStatusFromEvent(msg.event);
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

function updatePreviewStatusFromEvent(ev: ChatEvent): void {
  // turn が running 中だけ更新 (idle 復帰後に古い tool ラベルが残らないように)
  if (state.turn !== "running") return;
  if (ev.type === "tool-status") {
    const status = ev.state.status;
    if (status === "pending" || status === "running") {
      previewStatus.textContent = toolLabel(ev.tool, ev.state);
    } else if (status === "completed") {
      // 完了は短時間だけ示してから「生成中...」に戻す。次の running イベントで上書きされる。
      previewStatus.textContent = `${toolLabel(ev.tool, ev.state)} (完了)`;
    } else if (status === "error") {
      previewStatus.textContent = `${toolLabel(ev.tool, ev.state)} (失敗)`;
    }
    return;
  }
  if (ev.type === "step-finish") {
    previewStatus.textContent = "プレビュー反映中...";
    return;
  }
  if (ev.type === "error") {
    previewStatus.textContent = "エラー発生";
    return;
  }
}

function handleExportProgress(msg: ExportProgressMessage): void {
  if (msg.phase === "start") {
    setExportRunning(msg.kind, true);
    return;
  }
  setExportRunning(msg.kind, false);
  if (msg.phase === "error" && !msg.silent && msg.message) {
    const node: MessageNode = {
      id: `legacy-err-export-${Date.now()}`,
      role: "error",
      blocks: [
        { kind: "text", partId: "legacy", text: `[export:${msg.kind}] ${msg.message}` },
      ],
      createdAt: Date.now(),
    };
    state = {
      ...state,
      messages: [...state.messages, node],
    };
    scheduleRender();
  }
}


generateBtn.addEventListener("click", () => {
  const seedContent = seedInput.value.trim();
  if (!seedContent || state.turn !== "idle") {
    __electrobunSendToHost({
      type: "client-warn",
      event: "generate_click_ignored",
      detail: `seedLen=${seedContent.length} turn=${state.turn}`,
    });
    return;
  }

  dispatch({ type: "seed-generate", seed: seedContent });
  previewStatus.textContent = "生成中...";

  __electrobunSendToHost({ type: "generate", seedContent });
});

sendBtn.addEventListener("click", () => {
  sendChatMessage();
});

abortBtn.addEventListener("click", () => {
  if (state.turn !== "running") {
    __electrobunSendToHost({
      type: "client-warn",
      event: "abort_click_ignored",
      detail: `turn=${state.turn}`,
    });
    return;
  }
  dispatch({ type: "abort-requested" });
  __electrobunSendToHost({ type: "chat-cancel" });
});

chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

function sendChatMessage(): void {
  const content = chatInput.value.trim();
  if (!content || state.turn !== "idle") {
    __electrobunSendToHost({
      type: "client-warn",
      event: "chat_send_ignored",
      detail: `contentLen=${content.length} turn=${state.turn}`,
    });
    return;
  }

  dispatch({ type: "user-send", text: content });
  chatInput.value = "";

  __electrobunSendToHost({ type: "chat", content });
}

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
  if (!isValidApiKeyInput(value)) {
    __electrobunSendToHost({
      type: "client-warn",
      event: "api_key_submit_ignored",
      detail: `valueLen=${value.length}`,
    });
    return;
  }
  apiKeySubmitBtn.disabled = true;
  apiKeyError.classList.add("hidden");
  apiKeyError.textContent = "";
  __electrobunSendToHost({ type: "submit-api-key", key: value });
}

exportPdfBtn.addEventListener("click", () => {
  if (exportPdfBtn.disabled) {
    __electrobunSendToHost({
      type: "client-warn",
      event: "export_pdf_click_ignored",
      detail: "reason=button_disabled",
    });
    return;
  }
  __electrobunSendToHost({ type: "export-pdf" });
});

exportHtmlZipBtn.addEventListener("click", () => {
  if (exportHtmlZipBtn.disabled) {
    __electrobunSendToHost({
      type: "client-warn",
      event: "export_html_zip_click_ignored",
      detail: "reason=button_disabled",
    });
    return;
  }
  __electrobunSendToHost({ type: "export-html-zip" });
});

applyDevModeAttribute();
scheduleRender();

__electrobunSendToHost({ type: "ready" });

export {};
