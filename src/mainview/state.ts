/**
 * mainview の状態モデル + pure reducer.
 *
 * ChatBridge 由来の `ChatEvent` を受けてチャットログを構築する.
 * DOM に依存しないため bun test で R1-R15 をカバーできる (plan §5).
 *
 * blocks の並び順は同一 messageId 内の **最初の登場順 (partId / callId 初出順)** に従う.
 * SDK は SSE で 1 イベントずつ delivery するため (chat-bridge.ts の `for await` で順序保存),
 * 同時更新による順序破壊は発生しない (R-3).
 */

import type {
  ChatEvent,
  ChatEventError,
  ChatEventPermissionRequest,
  ChatEventReasoningChunk,
  ChatEventStepFinish,
  ChatEventTextChunk,
  ChatEventToolStatus,
  OpencodeToolState,
} from "../bun/opencode";

export type Role = "user" | "assistant" | "error";

export type ToolStatusKind = "pending" | "running" | "completed" | "error";

export interface TextBlock {
  kind: "text";
  partId: string;
  text: string;
}

export interface ReasoningBlock {
  kind: "reasoning";
  partId: string;
  text: string;
  /**
   * 初回作成時の折りたたみ初期値 (true = 閉じた状態で表示).
   * DOM 側の `<details open>` はユーザー操作を尊重するため、初回 render 後はこの値で
   * 強制同期しない (Risks Not Addressed: `<details>` open 状態の扱い).
   */
  collapsed: boolean;
}

export interface ToolStatusBlock {
  kind: "tool-status";
  partId: string;
  callId: string;
  tool: string;
  state: ToolStatusKind;
  label: string;
}

export type MessageBlock = TextBlock | ReasoningBlock | ToolStatusBlock;

export interface MessageNode {
  id: string;
  role: Role;
  blocks: MessageBlock[];
  createdAt: number;
}

export interface PermissionPrompt {
  permissionId: string;
  sessionId: string;
  callId?: string;
  kind: string;
  title: string;
  status: "pending" | "auto-allowed" | "user-allowed" | "user-denied";
}

export interface ChatLogState {
  messages: MessageNode[];
  activeMessageId: string | null;
  turn: "idle" | "running" | "aborting";
  permissions: PermissionPrompt[];
  rawTrail: ChatEvent[];
  lastUserInput: string | null;
  /**
   * null = bun からの project-mode を待機中 (R-1: race 回避のため UI を描画しない).
   * true = seed mode、false = chat mode.
   */
  seedMode: boolean | null;
}

export type Action =
  | { type: "user-send"; text: string }
  | { type: "chat-event"; event: ChatEvent }
  | { type: "permission-decide"; permissionId: string; allow: boolean }
  | { type: "abort-requested" }
  | { type: "seed-generate"; seed: string }
  | { type: "exit-seed-mode" }
  | { type: "retry-last" }
  | { type: "set-seed-mode"; mode: "seed" | "chat" };

const SEED_GENERATE_USER_TEXT = "[ドキュメントからスライドを生成]";

const AUTO_ALLOWED_PERMISSION_KINDS: ReadonlySet<string> = new Set(["edit", "read"]);

export function initialState(seedMode: boolean | null = null): ChatLogState {
  return {
    messages: [],
    activeMessageId: null,
    turn: "idle",
    permissions: [],
    rawTrail: [],
    lastUserInput: null,
    seedMode,
  };
}

export function reduce(state: ChatLogState, action: Action): ChatLogState {
  switch (action.type) {
    case "user-send":
      return appendUserMessage(state, action.text);
    case "seed-generate": {
      const next = appendUserMessage(state, SEED_GENERATE_USER_TEXT);
      return { ...next, seedMode: false, lastUserInput: action.seed };
    }
    case "exit-seed-mode":
      return { ...state, seedMode: false };
    case "set-seed-mode":
      return { ...state, seedMode: action.mode === "seed" };
    case "retry-last": {
      if (state.lastUserInput === null) return state;
      return appendUserMessage(state, state.lastUserInput);
    }
    case "abort-requested":
      if (state.turn !== "running") return state;
      return { ...state, turn: "aborting" };
    case "permission-decide":
      return decidePermission(state, action.permissionId, action.allow);
    case "chat-event":
      return handleChatEvent(state, action.event);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function appendUserMessage(state: ChatLogState, text: string): ChatLogState {
  const node: MessageNode = {
    id: `user-${state.messages.length}-${Date.now()}`,
    role: "user",
    blocks: [{ kind: "text", partId: "user-text", text }],
    createdAt: Date.now(),
  };
  return {
    ...state,
    messages: [...state.messages, node],
    activeMessageId: null,
    turn: "running",
    lastUserInput: text,
  };
}

function decidePermission(
  state: ChatLogState,
  permissionId: string,
  allow: boolean,
): ChatLogState {
  const idx = state.permissions.findIndex((p) => p.permissionId === permissionId);
  if (idx < 0) return state;
  const current = state.permissions[idx];
  if (!current) return state;
  const next = state.permissions.slice();
  next[idx] = {
    ...current,
    status: allow ? "user-allowed" : "user-denied",
  };
  return { ...state, permissions: next };
}

function handleChatEvent(state: ChatLogState, event: ChatEvent): ChatLogState {
  const trailed: ChatLogState = { ...state, rawTrail: [...state.rawTrail, event] };
  switch (event.type) {
    case "text-chunk":
      return applyTextChunk(trailed, event);
    case "reasoning-chunk":
      return applyReasoningChunk(trailed, event);
    case "tool-status":
      return applyToolStatus(trailed, event);
    case "permission-request":
      return applyPermissionRequest(trailed, event);
    case "step-finish":
      return applyStepFinish(trailed, event);
    case "error":
      return applyError(trailed, event);
    case "raw":
      return trailed;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function applyTextChunk(state: ChatLogState, event: ChatEventTextChunk): ChatLogState {
  return withAssistantMessage(state, event.messageId, (msg) => {
    const blockIdx = msg.blocks.findIndex(
      (b) => b.kind === "text" && b.partId === event.partId,
    );
    if (blockIdx >= 0) {
      const blocks = msg.blocks.slice();
      blocks[blockIdx] = { kind: "text", partId: event.partId, text: event.text };
      return { ...msg, blocks };
    }
    return {
      ...msg,
      blocks: [...msg.blocks, { kind: "text", partId: event.partId, text: event.text }],
    };
  });
}

function applyReasoningChunk(
  state: ChatLogState,
  event: ChatEventReasoningChunk,
): ChatLogState {
  return withAssistantMessage(state, event.messageId, (msg) => {
    const blockIdx = msg.blocks.findIndex(
      (b) => b.kind === "reasoning" && b.partId === event.partId,
    );
    if (blockIdx >= 0) {
      const existing = msg.blocks[blockIdx];
      if (existing && existing.kind === "reasoning") {
        const blocks = msg.blocks.slice();
        blocks[blockIdx] = { ...existing, text: event.text };
        return { ...msg, blocks };
      }
    }
    return {
      ...msg,
      blocks: [
        ...msg.blocks,
        { kind: "reasoning", partId: event.partId, text: event.text, collapsed: true },
      ],
    };
  });
}

function applyToolStatus(state: ChatLogState, event: ChatEventToolStatus): ChatLogState {
  return withAssistantMessage(state, event.messageId, (msg) => {
    const blockIdx = msg.blocks.findIndex(
      (b) => b.kind === "tool-status" && b.callId === event.callId,
    );
    const next: ToolStatusBlock = {
      kind: "tool-status",
      partId: event.partId,
      callId: event.callId,
      tool: event.tool,
      state: event.state.status,
      label: toolLabel(event.tool, event.state),
    };
    if (blockIdx >= 0) {
      const blocks = msg.blocks.slice();
      blocks[blockIdx] = next;
      return { ...msg, blocks };
    }
    return { ...msg, blocks: [...msg.blocks, next] };
  });
}

function applyPermissionRequest(
  state: ChatLogState,
  event: ChatEventPermissionRequest,
): ChatLogState {
  const status: PermissionPrompt["status"] = AUTO_ALLOWED_PERMISSION_KINDS.has(event.kind)
    ? "auto-allowed"
    : "pending";
  const prompt: PermissionPrompt = {
    permissionId: event.permissionId,
    sessionId: event.sessionId,
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
    kind: event.kind,
    title: event.title,
    status,
  };
  return { ...state, permissions: [...state.permissions, prompt] };
}

function applyStepFinish(state: ChatLogState, event: ChatEventStepFinish): ChatLogState {
  const updated = withAssistantMessage(state, event.messageId, (msg) => ({
    ...msg,
    blocks: msg.blocks.map((b) =>
      b.kind === "tool-status" && (b.state === "pending" || b.state === "running")
        ? { ...b, state: "completed" }
        : b,
    ),
  }));
  return { ...updated, turn: "idle", activeMessageId: null };
}

function applyError(state: ChatLogState, event: ChatEventError): ChatLogState {
  // Risk 保険: abort 中 (= ChatBridge.abort 後の dispatch 待ち) に SSE が遅延で
  // session-error / sse-closed / sdk-error を投げてきても、UI 側は静かに無視する.
  // turn === "aborting" は abort-requested 直後の grace window として扱う.
  if (state.turn === "aborting" && event.reason !== "abort") {
    return state;
  }

  if (event.reason === "abort") {
    let next = state;
    if (state.activeMessageId !== null) {
      next = withAssistantMessage(state, state.activeMessageId, (msg) => ({
        ...msg,
        blocks: msg.blocks.filter(
          (b) =>
            !(
              b.kind === "tool-status" &&
              (b.state === "pending" || b.state === "running")
            ),
        ),
      }));
    }
    return { ...next, turn: "idle", activeMessageId: null };
  }

  const errorNode: MessageNode = {
    id: `err-${state.messages.length}-${Date.now()}`,
    role: "error",
    blocks: [
      {
        kind: "text",
        partId: "error",
        text: errorReasonToText(event),
      },
    ],
    createdAt: Date.now(),
  };
  return {
    ...state,
    messages: [...state.messages, errorNode],
    turn: "idle",
    activeMessageId: null,
  };
}

function errorReasonToText(event: ChatEventError): string {
  switch (event.reason) {
    case "sse-closed":
      return "サーバーとの接続が切れました";
    case "session-error":
      return "セッションでエラーが発生しました";
    case "sdk-error":
      return "SDK エラーが発生しました";
    default:
      return `エラー: ${event.reason}`;
  }
}

/**
 * activeMessageId の MessageNode を見つけて updater を適用する.
 * 無ければ id=messageId / role="assistant" で新規作成し末尾に追加する.
 *
 * R-3 / Risks Not Addressed: 同一 messageId の MessageNode 重複生成を防ぐ共通ヘルパ.
 */
function withAssistantMessage(
  state: ChatLogState,
  messageId: string,
  updater: (msg: MessageNode) => MessageNode,
): ChatLogState {
  const idx = state.messages.findIndex((m) => m.id === messageId);
  if (idx >= 0) {
    const existing = state.messages[idx];
    if (!existing) return state;
    const next = state.messages.slice();
    next[idx] = updater(existing);
    return { ...state, messages: next, activeMessageId: messageId };
  }
  const created: MessageNode = {
    id: messageId,
    role: "assistant",
    blocks: [],
    createdAt: Date.now(),
  };
  return {
    ...state,
    messages: [...state.messages, updater(created)],
    activeMessageId: messageId,
  };
}

/**
 * tool 名 + ToolState から人間語ラベルを生成する pure 関数.
 * 不明な tool 名 / input フィールドが取れない場合は fallback ラベルを返す (plan §4.4).
 */
export function toolLabel(tool: string, state: OpencodeToolState): string {
  const input = (state as { input?: Record<string, unknown> }).input ?? {};
  switch (tool) {
    case "edit":
      return `ファイルを編集中: ${pickPath(input)}`;
    case "write":
      return `ファイルを書き込み中: ${pickPath(input)}`;
    case "read":
      return `ファイルを読み込み中: ${pickPath(input)}`;
    case "bash": {
      const cmd = pickString(input, ["command"]);
      const truncated = cmd.length > 40 ? `${cmd.slice(0, 40)}…` : cmd;
      return truncated.length > 0
        ? `コマンドを実行中: ${truncated}`
        : "コマンドを実行中…";
    }
    case "webfetch": {
      const url = pickString(input, ["url"]);
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        // not a parseable URL; fall back to the raw string
      }
      return host.length > 0 ? `Web 取得中: ${host}` : "Web 取得中…";
    }
    case "glob":
    case "grep":
      return "コードを検索中…";
    case "todoread":
    case "todowrite":
    case "todo_read":
    case "todo_write":
      return "タスクを更新中…";
    default:
      return `ツールを実行中: ${tool}`;
  }
}

function pickPath(input: Record<string, unknown>): string {
  return pickString(input, ["path", "filePath", "file_path"]);
}

function pickString(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}
