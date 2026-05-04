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
  AXIS_LABELS_JA,
  type DeckRubric,
  type RubricPreset,
} from "../bun/storage/rubric-types";
import {
  initialState,
  reduce,
  toolLabel,
  type Action,
  type ChatLogState,
  type InterviewState,
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

declare global {
  interface Window {
    __SLAIDO_RECEIVE__: (msg: ServerMessage) => void;
    __SLAIDO_DEV__?: boolean;
  }
}

const chatPane = document.getElementById("chat-pane") as HTMLDivElement;
const chatTabs = document.getElementById("chat-tabs") as HTMLDivElement;
const seedDisplay = document.getElementById("seed-display") as HTMLDivElement;
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

const generateSkipLink = document.getElementById("generate-skip-link") as HTMLButtonElement;
const presetSelectWrap = document.getElementById("preset-select-wrap") as HTMLDivElement;
const presetSelect = document.getElementById("preset-select") as HTMLSelectElement;

const interviewProgress = document.getElementById("interview-progress") as HTMLDivElement;
const interviewHistory = document.getElementById("interview-history") as HTMLDivElement;
const interviewQuestion = document.getElementById("interview-question") as HTMLDivElement;
const interviewError = document.getElementById("interview-error") as HTMLDivElement;
const interviewAnswerInput = document.getElementById("interview-answer-input") as HTMLTextAreaElement;
const interviewAnswerSubmit = document.getElementById("interview-answer-submit") as HTMLButtonElement;
const interviewCancelBtn = document.getElementById("interview-cancel-btn") as HTMLButtonElement;

const rubricEditForm = document.getElementById("rubric-edit-form") as HTMLDivElement;
const rubricHistoryList = document.getElementById("rubric-history-list") as HTMLDivElement;
const rubricGenerateBtn = document.getElementById("rubric-generate-btn") as HTMLButtonElement;
const rubricSaveAndGenerateBtn = document.getElementById("rubric-save-and-generate-btn") as HTMLButtonElement;
const rubricCancelBtn = document.getElementById("rubric-cancel-btn") as HTMLButtonElement;

const PURPOSE_OPTIONS = ["", "説得", "共有", "教育", "提案承認"] as const;

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
  applyPhaseClass();
  renderMessages();
  renderSeedDisplay();
  renderInputArea();
  renderPresetSelect();
  renderInterviewPane();
  renderRubricEditPane();
  if (isDevMode()) {
    renderDevRawTrail();
  }
}

type Phase = "loading" | "seed" | "interview" | "rubric-edit" | "chat";

function derivePhase(s: ChatLogState): Phase {
  if (s.seedMode === null) return "loading";
  if (s.interview?.phase === "rubric-edit") return "rubric-edit";
  if (s.interview?.phase === "asking") return "interview";
  if (s.seedMode === true) return "seed";
  return "chat";
}

function renderSeedDisplay(): void {
  const seed = state.seedDocument;
  if (seed === null || seed === "") {
    seedDisplay.classList.add("empty");
    seedDisplay.textContent = "シードはまだ入力されていません";
    return;
  }
  seedDisplay.classList.remove("empty");
  seedDisplay.textContent = seed;
}

type TabName = "chat" | "seed";

function setActiveTab(tab: TabName): void {
  chatPane.dataset["activeTab"] = tab;
  chatTabs.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset["tab"] === tab);
  });
  if (tab === "chat") {
    // 表示復帰時はスクロール末尾へ (display:none 中は scrollHeight が確定しないため
    // レイアウト確定後に rAF で実行)
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }
}

chatTabs.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset["tab"];
    if (tab === "chat" || tab === "seed") setActiveTab(tab);
  });
});

function applyPhaseClass(): void {
  document.body.dataset["phase"] = derivePhase(state);
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

function renderPresetSelect(): void {
  if (state.presets.length === 0) {
    presetSelectWrap.classList.add("hidden");
    return;
  }
  presetSelectWrap.classList.remove("hidden");
  // 既存の "選択しない" だけ残し、ほかを全部洗い替え (id 衝突しないので破壊的に)
  while (presetSelect.options.length > 1) {
    presetSelect.remove(1);
  }
  for (const p of state.presets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }
}

function renderInterviewPane(): void {
  const iv = state.interview;
  if (!iv) {
    interviewQuestion.textContent = "";
    interviewAnswerInput.value = "";
    return;
  }
  // 進捗表示: x / max
  if (iv.pendingQuestion) {
    interviewProgress.textContent =
      `Q${iv.pendingQuestion.askedCount} / 最大 ${iv.pendingQuestion.maxQuestions}`;
  } else {
    interviewProgress.textContent = "次の質問を生成中...";
  }
  // 質問本文 (textContent で書く — XSS 防止)
  if (iv.pendingQuestion) {
    interviewQuestion.classList.remove("loading");
    interviewQuestion.textContent = iv.pendingQuestion.question;
    interviewAnswerSubmit.disabled = false;
  } else {
    interviewQuestion.classList.add("loading");
    interviewQuestion.textContent = "...";
    interviewAnswerSubmit.disabled = true;
  }
  // 履歴 (textContent で q / a を書く — XSS 防止 / D7 / Risk 5.6)
  interviewHistory.textContent = "";
  for (const item of iv.log) {
    const wrap = document.createElement("div");
    wrap.className = "interview-history-item";
    const q = document.createElement("div");
    q.className = "q";
    q.textContent = `Q: ${item.q}`;
    const a = document.createElement("div");
    a.className = "a";
    a.textContent = `→ ${item.a}`;
    wrap.appendChild(q);
    wrap.appendChild(a);
    interviewHistory.appendChild(wrap);
  }
  // error 表示
  if (iv.error) {
    interviewError.classList.remove("hidden");
    interviewError.textContent = iv.error;
  } else {
    interviewError.classList.add("hidden");
    interviewError.textContent = "";
  }
}

function renderRubricEditPane(): void {
  const iv = state.interview;
  if (!iv || iv.phase !== "rubric-edit" || !iv.draftRubric) {
    return;
  }
  const rubric = iv.draftRubric;
  // 軸ごとに input 要素を組み立てる. textContent で label を書く.
  rubricEditForm.textContent = "";
  rubricEditForm.appendChild(buildAxisRow("audience", rubric));
  rubricEditForm.appendChild(buildAxisRow("duration_min", rubric));
  rubricEditForm.appendChild(buildAxisRow("purpose", rubric));
  rubricEditForm.appendChild(buildAxisRow("success_criteria", rubric));
  rubricEditForm.appendChild(buildAxisRow("tone", rubric));
  rubricEditForm.appendChild(buildAntiPatternsRow(rubric));

  // history (raw_interview_log は textContent 経由で render する — XSS 防止 / D7)
  rubricHistoryList.textContent = "";
  for (const turn of rubric.raw_interview_log) {
    const item = document.createElement("div");
    const q = document.createElement("div");
    q.textContent = `Q: ${turn.q}`;
    const a = document.createElement("div");
    a.textContent = `→ ${turn.a}`;
    item.appendChild(q);
    item.appendChild(a);
    rubricHistoryList.appendChild(item);
  }
}

function buildAxisRow(
  key: "audience" | "duration_min" | "purpose" | "success_criteria" | "tone",
  rubric: DeckRubric,
): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "rubric-axis";
  const label = document.createElement("label");
  label.textContent = AXIS_LABELS_JA[key] ?? key;
  wrap.appendChild(label);

  if (key === "purpose") {
    const select = document.createElement("select");
    for (const v of PURPOSE_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v === "" ? "—" : v;
      select.appendChild(opt);
    }
    select.value = rubric.axes.purpose ?? "";
    select.addEventListener("change", () => {
      const value = select.value;
      const next: DeckRubric = {
        ...rubric,
        axes: {
          ...rubric.axes,
          purpose:
            value === "説得" ||
            value === "共有" ||
            value === "教育" ||
            value === "提案承認"
              ? value
              : null,
        },
      };
      dispatch({ type: "rubric-edit-changed", rubric: next });
    });
    wrap.appendChild(select);
    return wrap;
  }

  if (key === "duration_min") {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value =
      rubric.axes.duration_min !== null ? String(rubric.axes.duration_min) : "";
    input.addEventListener("input", () => {
      const num = Number.parseInt(input.value, 10);
      const next: DeckRubric = {
        ...rubric,
        axes: {
          ...rubric.axes,
          duration_min: Number.isFinite(num) && num > 0 ? num : null,
        },
      };
      dispatch({ type: "rubric-edit-changed", rubric: next });
    });
    wrap.appendChild(input);
    return wrap;
  }

  // audience / success_criteria / tone は textarea
  const textarea = document.createElement("textarea");
  textarea.value = (rubric.axes as Record<string, unknown>)[key] as string ?? "";
  textarea.addEventListener("input", () => {
    const value = textarea.value;
    const next: DeckRubric = {
      ...rubric,
      axes: {
        ...rubric.axes,
        [key]: value === "" ? null : value,
      } as DeckRubric["axes"],
    };
    dispatch({ type: "rubric-edit-changed", rubric: next });
  });
  wrap.appendChild(textarea);
  return wrap;
}

function buildAntiPatternsRow(rubric: DeckRubric): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "rubric-axis";
  const label = document.createElement("label");
  label.textContent = AXIS_LABELS_JA["anti_patterns"] ?? "anti_patterns";
  wrap.appendChild(label);
  const list = document.createElement("div");
  list.className = "rubric-axis-anti-patterns";

  const items = rubric.axes.anti_patterns;

  function update(next: string[]): void {
    const updated: DeckRubric = {
      ...rubric,
      axes: { ...rubric.axes, anti_patterns: next },
    };
    dispatch({ type: "rubric-edit-changed", rubric: updated });
  }

  for (let i = 0; i < items.length; i++) {
    const row = document.createElement("div");
    row.className = "item";
    const input = document.createElement("input");
    input.type = "text";
    input.value = items[i] ?? "";
    input.addEventListener("input", () => {
      const next = items.slice();
      next[i] = input.value;
      update(next);
    });
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "削除";
    removeBtn.addEventListener("click", () => {
      const next = items.slice();
      next.splice(i, 1);
      update(next);
    });
    row.appendChild(input);
    row.appendChild(removeBtn);
    list.appendChild(row);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "add-btn";
  addBtn.textContent = "+ 追加";
  addBtn.addEventListener("click", () => {
    update([...items, ""]);
  });
  list.appendChild(addBtn);
  wrap.appendChild(list);
  return wrap;
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

  if (msg.type === "presets-list") {
    dispatch({ type: "preset-list-received", presets: msg.presets });
    return;
  }

  if (msg.type === "interview-question") {
    dispatch({
      type: "interview-question-received",
      turnIndex: msg.turnIndex,
      question: msg.question,
      askedCount: msg.askedCount,
      maxQuestions: msg.maxQuestions,
    });
    return;
  }

  if (msg.type === "interview-done") {
    dispatch({ type: "interview-finished", rubric: msg.rubric });
    return;
  }

  if (msg.type === "interview-error") {
    dispatch({ type: "interview-error", message: msg.message });
    return;
  }

  if (msg.type === "preset-saved") {
    // 保存成功フィードバック: 単純に preset 一覧を更新する (bun 側からの再 list は
    // orchestrator の責務. 既存 list が古い場合に備えてここでは挿入のみ).
    const exists = state.presets.some((p) => p.id === msg.preset.id);
    const next = exists ? state.presets : [msg.preset, ...state.presets];
    dispatch({ type: "preset-list-received", presets: next });
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

  // T019 — default は interview 経路 (A004 §「skip が default にならないよう注意」).
  dispatch({ type: "interview-start-requested", seed: seedContent });
  __electrobunSendToHost({ type: "interview-start", seedContent });
});

generateSkipLink.addEventListener("click", () => {
  const seedContent = seedInput.value.trim();
  if (!seedContent || state.turn !== "idle") {
    __electrobunSendToHost({
      type: "client-warn",
      event: "generate_skip_click_ignored",
      detail: `seedLen=${seedContent.length} turn=${state.turn}`,
    });
    return;
  }
  // skip 経路: 空 rubric で即生成へ (interview を経由しない).
  dispatch({ type: "seed-generate", seed: seedContent });
  previewStatus.textContent = "生成中...";
  __electrobunSendToHost({ type: "interview-skip", seedContent });
});

interviewAnswerSubmit.addEventListener("click", () => {
  submitInterviewAnswer();
});

interviewCancelBtn.addEventListener("click", () => {
  dispatch({ type: "interview-cancelled" });
  __electrobunSendToHost({ type: "interview-cancel" });
});

function submitInterviewAnswer(): void {
  if (!state.interview) return;
  const q = state.interview.pendingQuestion;
  if (!q) return;
  const answer = interviewAnswerInput.value.trim();
  if (!answer) return;
  const turnIndex = q.turnIndex;
  dispatch({ type: "interview-answer-submitted", answer });
  interviewAnswerInput.value = "";
  __electrobunSendToHost({ type: "interview-answer", turnIndex, answer });
}

rubricGenerateBtn.addEventListener("click", () => {
  sendRubricConfirm({ savePreset: false });
});

rubricSaveAndGenerateBtn.addEventListener("click", () => {
  if (!state.interview?.draftRubric) return;
  const name = window.prompt("preset の名前を入力してください (空欄で取り消し)");
  if (!name) return;
  sendRubricConfirm({ savePreset: true, presetName: name });
});

rubricCancelBtn.addEventListener("click", () => {
  dispatch({ type: "interview-cancelled" });
  __electrobunSendToHost({ type: "interview-cancel" });
});

function sendRubricConfirm(opts: { savePreset: boolean; presetName?: string }): void {
  const rubric = state.interview?.draftRubric;
  if (!rubric) return;
  // 確定後は seed-generate で interview を畳んで chat mode に遷移する.
  // (turn=running まで進めるのは bun から chat-event が届いてから — 既存の generate
  // 経路と同じハンドリングを保つため、ここでは seedDocument を保持しつつ interview
  // を null に倒す seed-generate action を再利用する.)
  const seed =
    state.interview?.seed ?? state.seedDocument ?? seedInput.value.trim();
  dispatch({ type: "seed-generate", seed });
  previewStatus.textContent = "生成中...";
  const payload: {
    type: "rubric-confirm";
    rubric: DeckRubric;
    seedContent: string;
    alsoSavePreset: boolean;
    presetName?: string;
  } = {
    type: "rubric-confirm",
    rubric,
    seedContent: seed,
    alsoSavePreset: opts.savePreset,
  };
  if (opts.presetName !== undefined) {
    payload.presetName = opts.presetName;
  }
  __electrobunSendToHost(payload);
}

presetSelect.addEventListener("change", () => {
  const id = presetSelect.value;
  if (!id) return;
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  // mainview だけで完結: preset.rubric を draftRubric に乗せて rubric-edit 画面へ
  dispatch({ type: "preset-use-requested", presetId: id });
  dispatch({ type: "interview-finished", rubric: preset.rubric });
  __electrobunSendToHost({ type: "use-preset", presetId: id });
  presetSelect.value = "";
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
// preset 一覧は最初の起動時に一度だけ取得 (空なら preset-select は hidden のまま)
__electrobunSendToHost({ type: "list-presets" });

export {};
