/**
 * mainview reducer の TDD テスト (T013 plan §5.2 R1-R15 + R-5 bonus + abort後error無視).
 */

import { describe, expect, test } from "bun:test";

import { initialState, reduce, toolLabel } from "./state";
import type { ChatLogState } from "./state";
import type {
  ChatEvent,
  ChatEventError,
  ChatEventPermissionRequest,
  ChatEventReasoningChunk,
  ChatEventRaw,
  ChatEventStepFinish,
  ChatEventTextChunk,
  ChatEventToolStatus,
  OpencodeRawEvent,
  OpencodeToolState,
} from "../bun/opencode";

const STUB_TEXT_RAW: Extract<OpencodeRawEvent, { type: "message.part.updated" }> = {
  type: "message.part.updated",
  properties: {
    part: {
      id: "stub",
      sessionID: "s",
      messageID: "m",
      type: "text",
      text: "",
    },
  },
};

const STUB_PERMISSION_RAW: Extract<OpencodeRawEvent, { type: "permission.updated" }> = {
  type: "permission.updated",
  properties: {
    id: "stub",
    type: "edit",
    sessionID: "s",
    messageID: "m",
    title: "stub",
    metadata: {},
    time: { created: 0 },
  },
};

const mkTextChunk = (
  messageId: string,
  partId: string,
  text: string,
  sessionId = "s1",
): ChatEventTextChunk => ({
  type: "text-chunk",
  sessionId,
  messageId,
  partId,
  text,
  raw: STUB_TEXT_RAW,
});

const mkReasoningChunk = (
  messageId: string,
  partId: string,
  text: string,
  sessionId = "s1",
): ChatEventReasoningChunk => ({
  type: "reasoning-chunk",
  sessionId,
  messageId,
  partId,
  text,
  raw: STUB_TEXT_RAW,
});

const mkToolStatus = (
  messageId: string,
  partId: string,
  callId: string,
  tool: string,
  state: OpencodeToolState,
  sessionId = "s1",
): ChatEventToolStatus => ({
  type: "tool-status",
  sessionId,
  messageId,
  partId,
  callId,
  tool,
  state,
  raw: STUB_TEXT_RAW,
});

const mkPermissionRequest = (
  permissionId: string,
  kind: string,
  title = "stub",
  callId?: string,
  messageId = "m1",
  sessionId = "s1",
): ChatEventPermissionRequest => ({
  type: "permission-request",
  sessionId,
  messageId,
  permissionId,
  ...(callId !== undefined ? { callId } : {}),
  title,
  kind,
  raw: STUB_PERMISSION_RAW,
});

const mkStepFinish = (
  messageId: string,
  sessionId = "s1",
): ChatEventStepFinish => ({
  type: "step-finish",
  sessionId,
  messageId,
  partId: "p-step",
  reason: "stop",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  raw: STUB_TEXT_RAW,
});

const mkError = (
  reason: ChatEventError["reason"],
  sessionId = "s1",
): ChatEventError => ({
  type: "error",
  sessionId,
  reason,
});

const mkRaw = (): ChatEventRaw => ({
  type: "raw",
  event: { type: "server.connected", properties: {} },
});

const dispatchEvent = (state: ChatLogState, event: ChatEvent): ChatLogState =>
  reduce(state, { type: "chat-event", event });

describe("initialState", () => {
  test("R1: 初期状態 seedMode=true は messages=[], turn=idle, seedMode=true", () => {
    const s = initialState(true);
    expect(s.messages).toEqual([]);
    expect(s.turn).toBe("idle");
    expect(s.seedMode).toBe(true);
    expect(s.activeMessageId).toBeNull();
    expect(s.permissions).toEqual([]);
    expect(s.rawTrail).toEqual([]);
    expect(s.lastUserInput).toBeNull();
  });

  test("R1b: 引数省略時は seedMode=null (R-1: project-mode 受信前のローディング)", () => {
    const s = initialState();
    expect(s.seedMode).toBeNull();
  });
});

describe("reduce / user input", () => {
  test("R2: seed-generate → user message 1 件、seedMode=false、turn=running、lastUserInput 保存", () => {
    const s = reduce(initialState(true), {
      type: "seed-generate",
      seed: "シード本文",
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("user");
    expect(s.seedMode).toBe(false);
    expect(s.turn).toBe("running");
    expect(s.lastUserInput).toBe("シード本文");
  });

  test("user-send: messages に user push、turn=running、lastUserInput=text", () => {
    const s = reduce(initialState(false), {
      type: "user-send",
      text: "編集して",
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("user");
    expect(s.turn).toBe("running");
    expect(s.lastUserInput).toBe("編集して");
  });

  test("R13: retry-last は lastUserInput を再投入し user MessageNode を 1 件追加 + turn=running", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "やり直し" });
    s = reduce(s, { type: "chat-event", event: mkError("sse-closed") });
    expect(s.turn).toBe("idle");
    s = reduce(s, { type: "retry-last" });
    expect(s.turn).toBe("running");
    const userMessages = s.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1]?.blocks[0]).toMatchObject({ kind: "text", text: "やり直し" });
  });

  test("retry-last: lastUserInput=null では no-op", () => {
    const s = reduce(initialState(false), { type: "retry-last" });
    expect(s.messages).toHaveLength(0);
    expect(s.turn).toBe("idle");
  });
});

describe("reduce / chat-event text/reasoning chunks", () => {
  test("R3: text-chunk 連続 3 回 (同 messageId / 同 partId) は同一 TextBlock を上書き", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(s, mkTextChunk("m1", "p1", "He"));
    s = dispatchEvent(s, mkTextChunk("m1", "p1", "Hell"));
    s = dispatchEvent(s, mkTextChunk("m1", "p1", "Hello"));
    const assistant = s.messages.find((m) => m.id === "m1");
    expect(assistant).toBeTruthy();
    expect(assistant?.blocks).toHaveLength(1);
    const block = assistant?.blocks[0];
    expect(block?.kind).toBe("text");
    expect(block?.kind === "text" ? block.text : null).toBe("Hello");
  });

  test("R4: reasoning-chunk が先行 → blocks は reasoning が先、text-chunk は 2 番目", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(s, mkReasoningChunk("m1", "r1", "考え中"));
    s = dispatchEvent(s, mkTextChunk("m1", "t1", "答え"));
    const assistant = s.messages.find((m) => m.id === "m1");
    expect(assistant?.blocks.map((b) => b.kind)).toEqual(["reasoning", "text"]);
  });

  test("R-3 補助: text → reasoning の順なら text が先、reasoning が後 (登場順を保つ)", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(s, mkTextChunk("m1", "t1", "答え"));
    s = dispatchEvent(s, mkReasoningChunk("m1", "r1", "考え中"));
    const assistant = s.messages.find((m) => m.id === "m1");
    expect(assistant?.blocks.map((b) => b.kind)).toEqual(["text", "reasoning"]);
  });
});

describe("reduce / chat-event tool-status", () => {
  test("R5: tool-status pending → running → completed は同 callId で in-place 更新", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(
      s,
      mkToolStatus("m1", "p1", "c1", "edit", {
        status: "pending",
        input: { path: "slides/index.html" },
        raw: "",
      }),
    );
    s = dispatchEvent(
      s,
      mkToolStatus("m1", "p1", "c1", "edit", {
        status: "running",
        input: { path: "slides/index.html" },
        time: { start: 1 },
      }),
    );
    s = dispatchEvent(
      s,
      mkToolStatus("m1", "p1", "c1", "edit", {
        status: "completed",
        input: { path: "slides/index.html" },
        output: "ok",
        title: "edit",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
    );
    const assistant = s.messages.find((m) => m.id === "m1");
    const toolBlocks = assistant?.blocks.filter((b) => b.kind === "tool-status") ?? [];
    expect(toolBlocks).toHaveLength(1);
    const block = toolBlocks[0];
    expect(block?.kind === "tool-status" ? block.state : null).toBe("completed");
  });

  test("R-5 bonus: 同 callId / 異 partId / status 上書きでもブロックは 1 件", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(
      s,
      mkToolStatus("m1", "partA", "c1", "edit", {
        status: "pending",
        input: { path: "a.txt" },
        raw: "",
      }),
    );
    s = dispatchEvent(
      s,
      mkToolStatus("m1", "partB", "c1", "edit", {
        status: "running",
        input: { path: "a.txt" },
        time: { start: 1 },
      }),
    );
    const assistant = s.messages.find((m) => m.id === "m1");
    const toolBlocks = assistant?.blocks.filter((b) => b.kind === "tool-status") ?? [];
    expect(toolBlocks).toHaveLength(1);
    const block = toolBlocks[0];
    expect(block?.kind === "tool-status" ? block.state : null).toBe("running");
  });

  test("R6: toolLabel(edit, path=slides/index.html)", () => {
    expect(
      toolLabel("edit", {
        status: "pending",
        input: { path: "slides/index.html" },
        raw: "",
      }),
    ).toBe("ファイルを編集中: slides/index.html");
  });

  test("toolLabel: bash は command 先頭", () => {
    expect(
      toolLabel("bash", {
        status: "running",
        input: { command: "echo hello" },
        time: { start: 1 },
      }),
    ).toContain("コマンドを実行中");
    expect(
      toolLabel("bash", {
        status: "running",
        input: { command: "echo hello" },
        time: { start: 1 },
      }),
    ).toContain("echo hello");
  });

  test("toolLabel: 不明な tool は ツールを実行中: <tool>", () => {
    expect(
      toolLabel("unknown_tool", {
        status: "pending",
        input: {},
        raw: "",
      }),
    ).toBe("ツールを実行中: unknown_tool");
  });
});

describe("reduce / chat-event permission-request", () => {
  test("R7: kind=edit は status=auto-allowed で permissions に push", () => {
    let s = initialState(false);
    s = dispatchEvent(s, mkPermissionRequest("perm-1", "edit", "Edit /tmp/x"));
    expect(s.permissions).toHaveLength(1);
    expect(s.permissions[0]?.status).toBe("auto-allowed");
  });

  test("R8: kind=bash は status=pending で permissions に push", () => {
    let s = initialState(false);
    s = dispatchEvent(s, mkPermissionRequest("perm-2", "bash", "Run bash"));
    expect(s.permissions).toHaveLength(1);
    expect(s.permissions[0]?.status).toBe("pending");
    expect(s.permissions[0]?.kind).toBe("bash");
  });

  test("permission-request: read は status=auto-allowed", () => {
    let s = initialState(false);
    s = dispatchEvent(s, mkPermissionRequest("perm-3", "read", "Read /tmp/x"));
    expect(s.permissions[0]?.status).toBe("auto-allowed");
  });

  test("permission-request: 未知 kind は status=pending (安全側)", () => {
    let s = initialState(false);
    s = dispatchEvent(s, mkPermissionRequest("perm-4", "mystery_tool", "?"));
    expect(s.permissions[0]?.status).toBe("pending");
  });

  test("R9: permission-decide allow → 該当 permissions のみ status=user-allowed", () => {
    let s = initialState(false);
    s = dispatchEvent(s, mkPermissionRequest("perm-1", "bash"));
    s = dispatchEvent(s, mkPermissionRequest("perm-2", "bash"));
    s = reduce(s, { type: "permission-decide", permissionId: "perm-1", allow: true });
    expect(s.permissions[0]?.status).toBe("user-allowed");
    expect(s.permissions[1]?.status).toBe("pending");
  });

  test("R9b: permission-decide deny → status=user-denied", () => {
    let s = initialState(false);
    s = dispatchEvent(s, mkPermissionRequest("perm-1", "bash"));
    s = reduce(s, { type: "permission-decide", permissionId: "perm-1", allow: false });
    expect(s.permissions[0]?.status).toBe("user-denied");
  });
});

describe("reduce / chat-event step-finish", () => {
  test("R10: step-finish は turn=idle, activeMessageId=null, 進行中 tool-status は completed に倒れる", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(
      s,
      mkToolStatus("m1", "p1", "c1", "edit", {
        status: "running",
        input: { path: "a.txt" },
        time: { start: 1 },
      }),
    );
    s = dispatchEvent(s, mkStepFinish("m1"));
    expect(s.turn).toBe("idle");
    expect(s.activeMessageId).toBeNull();
    const assistant = s.messages.find((m) => m.id === "m1");
    const tool = assistant?.blocks.find((b) => b.kind === "tool-status");
    expect(tool?.kind === "tool-status" ? tool.state : null).toBe("completed");
  });
});

describe("reduce / chat-event error", () => {
  test("R11: error reason=abort は turn=idle, 進行中 tool-status を除去, error メッセージは追加されない", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(
      s,
      mkToolStatus("m1", "p1", "c1", "bash", {
        status: "running",
        input: { command: "sleep 100" },
        time: { start: 1 },
      }),
    );
    s = dispatchEvent(s, mkError("abort"));
    expect(s.turn).toBe("idle");
    expect(s.activeMessageId).toBeNull();
    const errorMsg = s.messages.find((m) => m.role === "error");
    expect(errorMsg).toBeUndefined();
    const assistant = s.messages.find((m) => m.id === "m1");
    const stillRunning = assistant?.blocks.find(
      (b) => b.kind === "tool-status" && (b.state === "running" || b.state === "pending"),
    );
    expect(stillRunning).toBeUndefined();
  });

  test("R12: error reason=sse-closed は role=error の MessageNode を追加 + turn=idle", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(s, mkError("sse-closed"));
    expect(s.turn).toBe("idle");
    const errorMsg = s.messages.find((m) => m.role === "error");
    expect(errorMsg).toBeTruthy();
  });

  test("error reason=session-error は role=error の MessageNode を追加", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(s, mkError("session-error"));
    const errorMsg = s.messages.find((m) => m.role === "error");
    expect(errorMsg).toBeTruthy();
    expect(s.turn).toBe("idle");
  });
});

describe("reduce / abort-requested", () => {
  test("R15: abort-requested → turn=aborting, error reason=abort で idle に戻る", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = reduce(s, { type: "abort-requested" });
    expect(s.turn).toBe("aborting");
    s = dispatchEvent(s, mkError("abort"));
    expect(s.turn).toBe("idle");
  });

  test("abort 後の遅延 session-error は turn を変えない (Risk 保険)", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = reduce(s, { type: "abort-requested" });
    expect(s.turn).toBe("aborting");
    // SSE が遅延で session-error を投げてくるケース
    s = dispatchEvent(s, mkError("session-error"));
    expect(s.turn).toBe("aborting");
    const errorMsg = s.messages.find((m) => m.role === "error");
    expect(errorMsg).toBeUndefined();
    // 後続の error reason=abort で正常に idle 遷移
    s = dispatchEvent(s, mkError("abort"));
    expect(s.turn).toBe("idle");
  });
});

describe("reduce / raw", () => {
  test("R14: raw event は rawTrail に積まれる", () => {
    let s = initialState(false);
    s = dispatchEvent(s, mkRaw());
    expect(s.rawTrail).toHaveLength(1);
  });

  test("rawTrail には全イベントが積まれる (dev トグル ON で閲覧)", () => {
    let s = reduce(initialState(false), { type: "user-send", text: "x" });
    s = dispatchEvent(s, mkTextChunk("m1", "p1", "Hi"));
    s = dispatchEvent(s, mkRaw());
    expect(s.rawTrail.length).toBeGreaterThanOrEqual(2);
  });
});

describe("reduce / set-seed-mode (R-1 race 保険)", () => {
  test("初期 seedMode=null → set-seed-mode で確定", () => {
    let s = initialState();
    expect(s.seedMode).toBeNull();
    s = reduce(s, { type: "set-seed-mode", mode: "seed" });
    expect(s.seedMode).toBe(true);
    s = reduce(s, { type: "set-seed-mode", mode: "chat" });
    expect(s.seedMode).toBe(false);
  });
});

describe("reduce / immutability", () => {
  test("reduce は新しい state を返し元の state は変更しない", () => {
    const s0 = initialState(true);
    const s1 = reduce(s0, { type: "user-send", text: "x" });
    expect(s0.messages).toHaveLength(0);
    expect(s1.messages).toHaveLength(1);
    expect(s0).not.toBe(s1);
  });
});
