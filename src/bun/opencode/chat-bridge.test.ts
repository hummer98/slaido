/**
 * ChatBridge の bun:test スイート.
 *
 * SDK の HTTP/SSE は clientFactory injection でモック化する (plan §5 Step 3 注釈).
 * 実バイナリ統合テストは server-manager.test.ts と手動検証 (manual-verification.md) に委ねる.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";

import { ChatBridge, ChatBridgeInitError } from "./chat-bridge";
import type { OpencodeRawEvent } from "./types";

type AnyFn = (...args: any[]) => any;

type MockClient = {
  session: {
    create: Mock<AnyFn>;
    prompt: Mock<AnyFn>;
    abort: Mock<AnyFn>;
  };
  event: {
    subscribe: Mock<AnyFn>;
  };
  postSessionIdPermissionsPermissionId: Mock<AnyFn>;
};

type CapturedFactoryConfig = {
  baseUrl?: string;
  headers?: Record<string, string> | unknown;
};

function makeAsyncStream(
  events: OpencodeRawEvent[],
  opts: { keepOpen?: boolean; signal?: AbortSignal } = {},
): {
  stream: AsyncGenerator<OpencodeRawEvent, void, unknown>;
  close: () => void;
} {
  let closed = false;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((res) => {
    resolveClosed = () => res();
  });

  if (opts.signal?.aborted) {
    closed = true;
    resolveClosed();
  } else {
    opts.signal?.addEventListener("abort", () => {
      if (!closed) {
        closed = true;
        resolveClosed();
      }
    });
  }

  async function* gen(): AsyncGenerator<OpencodeRawEvent, void, unknown> {
    for (const e of events) {
      if (closed) return;
      yield e;
    }
    if (opts.keepOpen) {
      await closedPromise;
    }
  }

  return {
    stream: gen(),
    close: () => {
      if (!closed) {
        closed = true;
        resolveClosed?.();
      }
    },
  };
}

function makeMockClient(
  options: {
    initialEvents?: OpencodeRawEvent[];
    keepOpen?: boolean;
    onSubscribeCalled?: () => void;
  } = {},
): { client: MockClient; closeStream: () => void } {
  let closeFn: () => void = () => {};

  const subscribe = mock(async (opts?: { signal?: AbortSignal }) => {
    options.onSubscribeCalled?.();
    const stream = makeAsyncStream(options.initialEvents ?? [], {
      keepOpen: options.keepOpen ?? true,
      signal: opts?.signal,
    });
    closeFn = stream.close;
    return { stream: stream.stream };
  });

  const client: MockClient = {
    session: {
      create: mock(async (opts: { body?: { title?: string } }) => ({
        data: {
          id: "sess-1",
          projectID: "proj-1",
          directory: "/tmp",
          title: opts?.body?.title ?? "untitled",
          version: "1",
          time: { created: 0, updated: 0 },
        },
      })),
      prompt: mock(async () => ({ data: { info: {}, parts: [] } })),
      abort: mock(async () => ({ data: true })),
    },
    event: { subscribe },
    postSessionIdPermissionsPermissionId: mock(async () => ({ data: true })),
  };

  return { client, closeStream: () => closeFn() };
}

describe("ChatBridge.init / dispose", () => {
  let bridge: ChatBridge | null = null;
  let captured: CapturedFactoryConfig | null = null;
  let lastClient: MockClient | null = null;
  let lastClose: (() => void) | null = null;

  beforeEach(() => {
    captured = null;
    lastClient = null;
    lastClose = null;
  });

  afterEach(async () => {
    if (bridge) {
      await bridge.dispose();
      bridge = null;
    }
    lastClose?.();
  });

  test("init で Authorization: Basic <base64> ヘッダが Config に渡る", async () => {
    bridge = new ChatBridge({
      clientFactory: (config) => {
        captured = config as CapturedFactoryConfig;
        const { client, closeStream } = makeMockClient();
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });

    await bridge.init({
      baseUrl: "http://127.0.0.1:54321",
      password: "secret-pw",
      username: "opencode",
    });

    expect(captured?.baseUrl).toBe("http://127.0.0.1:54321");
    const headers = captured?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from("opencode:secret-pw").toString("base64")}`;
    expect(headers.Authorization).toBe(expected);
  });

  test("init を 2 回呼んでも subscribe は 1 度しか呼ばれない", async () => {
    let subCount = 0;
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient({
          onSubscribeCalled: () => {
            subCount++;
          },
        });
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });

    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });
    expect(subCount).toBe(1);
  });

  test("dispose 後の sendMessage は ChatBridgeInitError を投げる", async () => {
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient();
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });
    await bridge.dispose();

    await expect(
      bridge.sendMessage({
        sessionId: "sess-1",
        parts: [{ type: "text", text: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ChatBridgeInitError);
  });

  test("init() より前の sendMessage は ChatBridgeInitError", async () => {
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient();
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });

    await expect(
      bridge.sendMessage({
        sessionId: "sess-1",
        parts: [{ type: "text", text: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ChatBridgeInitError);
  });
});

describe("ChatBridge.createSession", () => {
  let bridge: ChatBridge | null = null;
  let lastClient: MockClient | null = null;
  let lastClose: (() => void) | null = null;

  afterEach(async () => {
    if (bridge) {
      await bridge.dispose();
      bridge = null;
    }
    lastClose?.();
  });

  test("client.session.create が title 付きで呼ばれ sessionId を返す", async () => {
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient();
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });

    const out = await bridge.createSession({ title: "Untitled" });
    expect(out.sessionId).toBe("sess-1");
    expect(lastClient!.session.create).toHaveBeenCalledTimes(1);
    expect(lastClient!.session.create.mock.calls[0]?.[0]).toMatchObject({
      body: { title: "Untitled" },
    });
  });

  test("directory 付きで呼ぶと query.directory に乗る", async () => {
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient();
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });
    await bridge.createSession({ title: "T", directory: "/work/proj" });
    expect(lastClient!.session.create.mock.calls[0]?.[0]).toMatchObject({
      query: { directory: "/work/proj" },
    });
  });
});

describe("ChatBridge.sendMessage / abort (per-session AbortController)", () => {
  let bridge: ChatBridge | null = null;
  let lastClient: MockClient | null = null;
  let lastClose: (() => void) | null = null;

  afterEach(async () => {
    if (bridge) {
      await bridge.dispose();
      bridge = null;
    }
    lastClose?.();
  });

  test("client.session.prompt が path/body/signal 付きで呼ばれる", async () => {
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient();
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });
    await bridge.sendMessage({
      sessionId: "sess-1",
      parts: [{ type: "text", text: "Hello" }],
      model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" },
    });

    const args = lastClient!.session.prompt.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      path: { id: "sess-1" },
      body: {
        parts: [{ type: "text", text: "Hello" }],
        model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" },
      },
    });
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  test("defaultModel は init で渡したものを使う", async () => {
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient();
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({
      baseUrl: "http://127.0.0.1:54321",
      password: "x",
      defaultModel: { providerID: "p1", modelID: "m1" },
    });
    await bridge.sendMessage({
      sessionId: "sess-1",
      parts: [{ type: "text", text: "Hello" }],
    });
    const args = lastClient!.session.prompt.mock.calls[0]?.[0];
    expect(args.body.model).toEqual({ providerID: "p1", modelID: "m1" });
  });

  test("同一 sessionId への重複 sendMessage は前回 AbortController を abort", async () => {
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient();
        // 先に呼ばれた prompt は signal が abort されるまで pending のままにする
        client.session.prompt = mock(async (opts: { signal?: AbortSignal }) => {
          await new Promise<void>((resolveP, rejectP) => {
            if (opts.signal?.aborted) {
              rejectP(new DOMException("Aborted", "AbortError"));
              return;
            }
            opts.signal?.addEventListener("abort", () => {
              rejectP(new DOMException("Aborted", "AbortError"));
            });
            setTimeout(() => resolveP(), 1000);
          });
          return { data: { info: {}, parts: [] } };
        });
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });

    const firstCall = bridge.sendMessage({
      sessionId: "sess-1",
      parts: [{ type: "text", text: "first" }],
    });

    // first を握りつぶさないように catch
    const firstResult = firstCall.catch((err) => err);

    await bridge.sendMessage({
      sessionId: "sess-1",
      parts: [{ type: "text", text: "second" }],
    });

    const firstErr = await firstResult;
    expect(firstErr).toBeInstanceOf(Error);
    expect((firstErr as Error).name).toBe("AbortError");
  });

  test("abort(sessionId) で client.session.abort が呼ばれ error event が流れる", async () => {
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient();
        client.session.prompt = mock(async (opts: { signal?: AbortSignal }) => {
          await new Promise<void>((resolveP, rejectP) => {
            opts.signal?.addEventListener("abort", () => {
              rejectP(new DOMException("Aborted", "AbortError"));
            });
            setTimeout(() => resolveP(), 1000);
          });
          return { data: { info: {}, parts: [] } };
        });
        lastClient = client;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });

    const events: Array<{ type: string; reason?: string; sessionId?: string }> = [];
    bridge.onEvent((ev) => {
      events.push(ev as never);
    });

    const sending = bridge
      .sendMessage({
        sessionId: "sess-1",
        parts: [{ type: "text", text: "hi" }],
      })
      .catch(() => undefined);

    // microtask flush
    await Promise.resolve();
    await bridge.abort("sess-1");
    await sending;

    expect(lastClient!.session.abort).toHaveBeenCalledTimes(1);
    expect(lastClient!.session.abort.mock.calls[0]?.[0]).toMatchObject({
      path: { id: "sess-1" },
    });
    const abortEvent = events.find(
      (e) => e.type === "error" && e.reason === "abort",
    );
    expect(abortEvent).toBeDefined();
    expect(abortEvent?.sessionId).toBe("sess-1");
  });
});

describe("ChatBridge.onEvent (subscribe ループ + dispatcher)", () => {
  let bridge: ChatBridge | null = null;
  let lastClose: (() => void) | null = null;

  afterEach(async () => {
    if (bridge) {
      await bridge.dispose();
      bridge = null;
    }
    lastClose?.();
  });

  test("3 イベント yield → text-chunk / tool-status / raw に分配", async () => {
    const events: OpencodeRawEvent[] = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p1",
            sessionID: "s1",
            messageID: "m1",
            type: "text",
            text: "Hi",
          },
          delta: "Hi",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p2",
            sessionID: "s1",
            messageID: "m1",
            type: "tool",
            callID: "c1",
            tool: "read",
            state: { status: "running", input: {}, time: { start: 0 } },
          },
        },
      },
      {
        type: "session.idle",
        properties: { sessionID: "s1" },
      },
    ];

    let close!: () => void;
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient({
          initialEvents: events,
          keepOpen: true,
        });
        close = closeStream;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });

    const seen: Array<{ type: string }> = [];
    bridge.onEvent((ev) => seen.push({ type: ev.type }));

    // yield が処理されるまで待機
    await new Promise((r) => setTimeout(r, 30));

    const types = seen.map((e) => e.type);
    expect(types).toContain("text-chunk");
    expect(types).toContain("tool-status");
    expect(types).toContain("raw");
    close();
  });

  test("ハンドラ throw しても他のハンドラに影響しない", async () => {
    const events: OpencodeRawEvent[] = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p1",
            sessionID: "s1",
            messageID: "m1",
            type: "text",
            text: "Hi",
          },
          delta: "Hi",
        },
      },
    ];
    let close!: () => void;
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient({
          initialEvents: events,
          keepOpen: true,
        });
        close = closeStream;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });

    let goodCalled = 0;
    bridge.onEvent(() => {
      throw new Error("bad handler");
    });
    bridge.onEvent(() => {
      goodCalled++;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(goodCalled).toBeGreaterThan(0);
    close();
  });

  test("AsyncGenerator 終了 → sse-closed が 1 回だけ流れる", async () => {
    let close!: () => void;
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient({ keepOpen: true });
        close = closeStream;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });

    const events: Array<{ type: string; reason?: string }> = [];
    bridge.onEvent((ev) => events.push(ev as never));

    // 即座にストリームを閉じる
    close();
    await new Promise((r) => setTimeout(r, 30));

    const closed = events.filter(
      (e) => e.type === "error" && e.reason === "sse-closed",
    );
    expect(closed).toHaveLength(1);
  });
});

describe("ChatBridge round-trip (mock)", () => {
  let bridge: ChatBridge | null = null;
  let lastClose: (() => void) | null = null;

  afterEach(async () => {
    if (bridge) {
      await bridge.dispose();
      bridge = null;
    }
    lastClose?.();
  });

  test("sendMessage 後に subscribe が text-chunk × 3 + step-finish を流す → 累積テキストを取り出せる", async () => {
    const events: OpencodeRawEvent[] = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p1",
            sessionID: "s1",
            messageID: "m1",
            type: "text",
            text: "Hel",
          },
          delta: "Hel",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p1",
            sessionID: "s1",
            messageID: "m1",
            type: "text",
            text: "Hello",
          },
          delta: "lo",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p1",
            sessionID: "s1",
            messageID: "m1",
            type: "text",
            text: "Hello!",
          },
          delta: "!",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p2",
            sessionID: "s1",
            messageID: "m1",
            type: "step-finish",
            reason: "stop",
            cost: 0.01,
            tokens: {
              input: 5,
              output: 3,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
      },
    ];
    let close!: () => void;
    bridge = new ChatBridge({
      clientFactory: () => {
        const { client, closeStream } = makeMockClient({
          initialEvents: events,
          keepOpen: true,
        });
        close = closeStream;
        lastClose = closeStream;
        return client as unknown as never;
      },
    });
    await bridge.init({ baseUrl: "http://127.0.0.1:54321", password: "x" });

    const collected: { text?: string; finished?: boolean } = {};
    bridge.onEvent((ev) => {
      if (ev.type === "text-chunk") collected.text = ev.text;
      if (ev.type === "step-finish") collected.finished = true;
    });

    await bridge.sendMessage({
      sessionId: "s1",
      parts: [{ type: "text", text: "Hi" }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(collected.text).toBe("Hello!");
    expect(collected.finished).toBe(true);
    close();
  });
});
