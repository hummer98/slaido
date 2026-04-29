/**
 * normalizeEvent の variant 対応テスト.
 *
 * SDK 1.14.29 の Event union (`message.part.updated` × Part 種別 / `permission.updated` /
 * `session.error` / その他) を 1 件の入力に対し 1 件以上の ChatEvent[] にマッピングする.
 */

import { describe, expect, test } from "bun:test";

import { normalizeEvent } from "./types";
import type { OpencodeRawEvent } from "./types";

describe("normalizeEvent", () => {
  test("text part → text-chunk", () => {
    const raw: OpencodeRawEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "m1",
          type: "text",
          text: "Hello",
        },
        delta: "Hello",
      },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([
      {
        type: "text-chunk",
        sessionId: "s1",
        messageId: "m1",
        partId: "p1",
        text: "Hello",
        delta: "Hello",
        raw,
      },
    ]);
  });

  test("text part without delta → text-chunk with no delta", () => {
    const raw: OpencodeRawEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p2",
          sessionID: "s1",
          messageID: "m1",
          type: "text",
          text: "complete text",
        },
      },
    };
    const out = normalizeEvent(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "text-chunk",
      sessionId: "s1",
      messageId: "m1",
      partId: "p2",
      text: "complete text",
    });
    expect((out[0] as { delta?: string }).delta).toBeUndefined();
  });

  test("reasoning part → reasoning-chunk", () => {
    const raw: OpencodeRawEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p3",
          sessionID: "s1",
          messageID: "m1",
          type: "reasoning",
          text: "thinking...",
          time: { start: 0 },
        },
        delta: "ing...",
      },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([
      {
        type: "reasoning-chunk",
        sessionId: "s1",
        messageId: "m1",
        partId: "p3",
        text: "thinking...",
        delta: "ing...",
        raw,
      },
    ]);
  });

  test("tool part → tool-status", () => {
    const raw: OpencodeRawEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p4",
          sessionID: "s1",
          messageID: "m1",
          type: "tool",
          callID: "call_1",
          tool: "read",
          state: {
            status: "running",
            input: { path: "/foo" },
            time: { start: 1 },
          },
        },
      },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([
      {
        type: "tool-status",
        sessionId: "s1",
        messageId: "m1",
        partId: "p4",
        callId: "call_1",
        tool: "read",
        state: {
          status: "running",
          input: { path: "/foo" },
          time: { start: 1 },
        },
        raw,
      },
    ]);
  });

  test("step-finish part → step-finish event", () => {
    const raw: OpencodeRawEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p5",
          sessionID: "s1",
          messageID: "m1",
          type: "step-finish",
          reason: "stop",
          cost: 0.0123,
          tokens: {
            input: 10,
            output: 20,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([
      {
        type: "step-finish",
        sessionId: "s1",
        messageId: "m1",
        partId: "p5",
        reason: "stop",
        cost: 0.0123,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        raw,
      },
    ]);
  });

  test("snapshot part → raw passthrough", () => {
    const raw: OpencodeRawEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p6",
          sessionID: "s1",
          messageID: "m1",
          type: "snapshot",
          snapshot: "abc",
        },
      },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([{ type: "raw", event: raw }]);
  });

  test("permission.updated → permission-request", () => {
    const raw: OpencodeRawEvent = {
      type: "permission.updated",
      properties: {
        id: "perm-1",
        type: "edit",
        sessionID: "s1",
        messageID: "m1",
        callID: "call_2",
        title: "Edit /tmp/foo",
        metadata: {},
        time: { created: 0 },
      },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([
      {
        type: "permission-request",
        sessionId: "s1",
        messageId: "m1",
        permissionId: "perm-1",
        callId: "call_2",
        title: "Edit /tmp/foo",
        kind: "edit",
        raw,
      },
    ]);
  });

  test("session.error → error event with reason 'session-error'", () => {
    const raw: OpencodeRawEvent = {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: {
          name: "ProviderAuthError",
          data: { providerID: "openrouter", message: "no api key" },
        },
      },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([
      {
        type: "error",
        sessionId: "s1",
        reason: "session-error",
        error: {
          name: "ProviderAuthError",
          data: { providerID: "openrouter", message: "no api key" },
        },
        raw,
      },
    ]);
  });

  test("server.connected → raw passthrough", () => {
    const raw: OpencodeRawEvent = {
      type: "server.connected",
      properties: {},
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([{ type: "raw", event: raw }]);
  });

  test("session.idle → raw passthrough", () => {
    const raw: OpencodeRawEvent = {
      type: "session.idle",
      properties: { sessionID: "s1" },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([{ type: "raw", event: raw }]);
  });

  test("file.edited → raw passthrough", () => {
    const raw: OpencodeRawEvent = {
      type: "file.edited",
      properties: { file: "/tmp/foo" },
    };
    const out = normalizeEvent(raw);
    expect(out).toEqual([{ type: "raw", event: raw }]);
  });
});
