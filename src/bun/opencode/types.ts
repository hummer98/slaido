/**
 * ChatBridge が WebView (および T012 / T013) に渡す正規化イベント.
 *
 * 設計方針 (plan §2.3):
 *   - 各 variant は raw SSE event の重要フィールドを保持
 *   - 元 event を `raw` フィールドで保持し UI 側で取りこぼし補完を可能にする
 *   - 正規化対象外の event (server.connected / session.idle / file.edited 等) は
 *     `{ type: "raw", event }` で透過配送
 */

import type {
  Event as OpencodeRawEvent,
  Part as OpencodePart,
  Permission as OpencodePermission,
  ToolState as OpencodeToolState,
  AssistantMessage,
  UserMessage,
  Message,
} from "@opencode-ai/sdk";

export type {
  OpencodeRawEvent,
  OpencodePart,
  OpencodePermission,
  OpencodeToolState,
  AssistantMessage,
  UserMessage,
  Message,
};

export type ChatEventTextChunk = {
  type: "text-chunk";
  sessionId: string;
  messageId: string;
  partId: string;
  /** 累積されたテキスト. 末尾に delta が追加された後の値. */
  text: string;
  /** 直近差分. SDK が delta を出さない場合は undefined. */
  delta?: string;
  raw: Extract<OpencodeRawEvent, { type: "message.part.updated" }>;
};

export type ChatEventReasoningChunk = {
  type: "reasoning-chunk";
  sessionId: string;
  messageId: string;
  partId: string;
  text: string;
  delta?: string;
  raw: Extract<OpencodeRawEvent, { type: "message.part.updated" }>;
};

export type ChatEventToolStatus = {
  type: "tool-status";
  sessionId: string;
  messageId: string;
  partId: string;
  callId: string;
  tool: string;
  state: OpencodeToolState;
  raw: Extract<OpencodeRawEvent, { type: "message.part.updated" }>;
};

export type ChatEventPermissionRequest = {
  type: "permission-request";
  sessionId: string;
  messageId: string;
  permissionId: string;
  callId?: string;
  title: string;
  /** opencode の Permission.type. `"edit"` / `"bash"` / `"webfetch"` 等. */
  kind: string;
  raw: Extract<OpencodeRawEvent, { type: "permission.updated" }>;
};

export type ChatEventStepFinish = {
  type: "step-finish";
  sessionId: string;
  messageId: string;
  partId: string;
  reason: string;
  cost: number;
  /** SDK 実型に合わせて非 optional (design-review 4-f). */
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  raw: Extract<OpencodeRawEvent, { type: "message.part.updated" }>;
};

export type ChatEventError = {
  type: "error";
  sessionId?: string;
  /** "sdk-error" / "sse-closed" / "session-error" / "abort" */
  reason: "sdk-error" | "sse-closed" | "session-error" | "abort";
  /** 元エラー. Error 型でない可能性あり. JSON 化を保証しない. */
  error?: unknown;
  raw?: Extract<OpencodeRawEvent, { type: "session.error" }>;
};

export type ChatEventRaw = {
  type: "raw";
  event: OpencodeRawEvent;
};

export type ChatEvent =
  | ChatEventTextChunk
  | ChatEventReasoningChunk
  | ChatEventToolStatus
  | ChatEventPermissionRequest
  | ChatEventStepFinish
  | ChatEventError
  | ChatEventRaw;

/** `src/bun/index.ts` が UI へ転送する型. ServerMessage に追加する variant の元. */
export type ChatEventForWire = ChatEvent;

/**
 * MVP では使わないが型だけ予約 (plan §9.4 / design-review 4-a).
 *
 * SDK 1.14.29 の `SessionPromptData.body` には format フィールドが無いため,
 * 実 SDK が format をサポートしたら body 注入経路を追加する.
 */
export type StructuredOutputFormat = {
  type: "json_schema";
  schema: object;
  retryCount?: number;
};

/**
 * SSE 上の生 Event を ChatEvent (1 件以上) に正規化する.
 *
 * 1 件の raw event は **常に 1 件以上** の ChatEvent[] を返す.
 * 該当する variant が無い event はすべて `{ type: "raw", event }` で透過配送.
 */
export function normalizeEvent(event: OpencodeRawEvent): ChatEvent[] {
  if (event.type === "message.part.updated") {
    const part = event.properties.part;
    const delta = event.properties.delta;
    switch (part.type) {
      case "text":
        return [
          {
            type: "text-chunk",
            sessionId: part.sessionID,
            messageId: part.messageID,
            partId: part.id,
            text: part.text,
            ...(delta !== undefined ? { delta } : {}),
            raw: event,
          },
        ];
      case "reasoning":
        return [
          {
            type: "reasoning-chunk",
            sessionId: part.sessionID,
            messageId: part.messageID,
            partId: part.id,
            text: part.text,
            ...(delta !== undefined ? { delta } : {}),
            raw: event,
          },
        ];
      case "tool":
        return [
          {
            type: "tool-status",
            sessionId: part.sessionID,
            messageId: part.messageID,
            partId: part.id,
            callId: part.callID,
            tool: part.tool,
            state: part.state,
            raw: event,
          },
        ];
      case "step-finish":
        return [
          {
            type: "step-finish",
            sessionId: part.sessionID,
            messageId: part.messageID,
            partId: part.id,
            reason: part.reason,
            cost: part.cost,
            tokens: part.tokens,
            raw: event,
          },
        ];
      default:
        return [{ type: "raw", event }];
    }
  }

  if (event.type === "permission.updated") {
    const p = event.properties;
    return [
      {
        type: "permission-request",
        sessionId: p.sessionID,
        messageId: p.messageID,
        permissionId: p.id,
        ...(p.callID !== undefined ? { callId: p.callID } : {}),
        title: p.title,
        kind: p.type,
        raw: event,
      },
    ];
  }

  if (event.type === "session.error") {
    const props = event.properties;
    return [
      {
        type: "error",
        ...(props.sessionID !== undefined ? { sessionId: props.sessionID } : {}),
        reason: "session-error",
        error: props.error,
        raw: event,
      },
    ];
  }

  return [{ type: "raw", event }];
}
