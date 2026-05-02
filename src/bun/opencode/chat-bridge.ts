/**
 * ChatBridge — `@opencode-ai/sdk` を薄くラップした上位 API.
 *
 * 状態遷移: constructed → init() → ready → dispose() → closed
 *
 * 並行 send は per-session AbortController で隔離.
 * subscribe は init() 内で 1 本だけ張り、全 session の event を 1 つのストリームで受ける
 * (opencode 側仕様).
 *
 * SSE 自動再接続は無効 (sseMaxRetryAttempts: 0). 切断時は `error` event を 1 回だけ emit.
 */

import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeClientConfig,
} from "@opencode-ai/sdk";

import { normalizeEvent } from "./types";
import type { ChatEvent, OpencodeRawEvent } from "./types";
import { error as logError, fmtErr } from "../logger";

export interface ChatBridgeInitArgs {
  /** OpencodeServerManager.start() が返した baseUrl */
  baseUrl: string;
  /** OPENCODE_SERVER_PASSWORD と同じ値 */
  password: string;
  /** default "opencode" */
  username?: string;
  /** 既定モデル. sendMessage の model 省略時に使う */
  defaultModel?: { providerID: string; modelID: string };
}

export interface CreateSessionArgs {
  title: string;
  /** opencode サーバの cwd を切り替えたい場合のみ. default: server-manager の cwd */
  directory?: string;
}

export interface SendMessageArgs {
  sessionId: string;
  parts: Array<
    | { type: "text"; text: string }
    | {
        type: "file";
        mime: string;
        url: string;
        filename?: string;
        source?: unknown;
      }
  >;
  /** 省略時は init() の defaultModel. */
  model?: { providerID: string; modelID: string };
  /**
   * MVP 不使用 (plan §9.4 / design-review 4-a).
   * SDK 1.14.29 の body には format フィールドが無いため、ここで受け取っても無視する.
   */
  format?: { type: "json_schema"; schema: object; retryCount?: number };
}

export type ChatEventHandler = (event: ChatEvent) => void;
export type Unsubscribe = () => void;

export class ChatBridgeInitError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ChatBridgeInitError";
    this.cause = cause;
  }
}

interface ChatBridgeOptions {
  /** テスト・拡張用. production では未指定で `createOpencodeClient` を使う. */
  clientFactory?: (config: OpencodeClientConfig) => OpencodeClient;
}

const DEFAULT_USERNAME = "opencode";

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export class ChatBridge {
  private client: OpencodeClient | null = null;
  private subscribeController: AbortController | null = null;
  private subscribeLoopPromise: Promise<void> | null = null;
  private subscribeStream: AsyncGenerator<OpencodeRawEvent, void, unknown> | null =
    null;
  private readonly controllers = new Map<string, AbortController>();
  private readonly handlers = new Set<ChatEventHandler>();
  private defaultModel: ChatBridgeInitArgs["defaultModel"];
  private auth: { username: string; password: string } | null = null;
  private initialized = false;
  private disposing = false;
  private sseClosedEmitted = false;
  private readonly clientFactory: NonNullable<ChatBridgeOptions["clientFactory"]>;

  constructor(options: ChatBridgeOptions = {}) {
    this.clientFactory = options.clientFactory ?? ((config) => createOpencodeClient(config));
  }

  getClient(): OpencodeClient | null {
    return this.client;
  }

  async init(args: ChatBridgeInitArgs): Promise<void> {
    if (this.initialized) return;

    const username = args.username ?? DEFAULT_USERNAME;
    this.auth = { username, password: args.password };
    this.defaultModel = args.defaultModel;

    let client: OpencodeClient;
    try {
      client = this.clientFactory({
        baseUrl: args.baseUrl,
        headers: { Authorization: basicAuthHeader(username, args.password) },
      });
    } catch (err) {
      throw new ChatBridgeInitError(
        `failed to create opencode client: ${(err as Error).message}`,
        err,
      );
    }

    this.client = client;
    this.subscribeController = new AbortController();

    let subscribeResult: { stream: AsyncGenerator<OpencodeRawEvent, void, unknown> };
    try {
      subscribeResult = (await client.event.subscribe({
        signal: this.subscribeController.signal,
        sseMaxRetryAttempts: 0,
      })) as unknown as { stream: AsyncGenerator<OpencodeRawEvent, void, unknown> };
    } catch (err) {
      this.client = null;
      this.subscribeController = null;
      throw new ChatBridgeInitError(
        `failed to subscribe to opencode events: ${(err as Error).message}`,
        err,
      );
    }

    this.subscribeStream = subscribeResult.stream;
    this.initialized = true;
    this.sseClosedEmitted = false;
    this.subscribeLoopPromise = this.runSubscribeLoop(subscribeResult.stream);
  }

  private async runSubscribeLoop(
    stream: AsyncGenerator<OpencodeRawEvent, void, unknown>,
  ): Promise<void> {
    try {
      for await (const event of stream) {
        for (const normalized of normalizeEvent(event)) {
          this.dispatch(normalized);
        }
      }
    } catch (err) {
      if (!this.disposing) {
        this.emitSseClosed(err);
      }
    } finally {
      if (!this.disposing) {
        this.emitSseClosed();
      }
    }
  }

  private emitSseClosed(error?: unknown): void {
    if (this.sseClosedEmitted) return;
    this.sseClosedEmitted = true;
    this.dispatch({
      type: "error",
      reason: "sse-closed",
      error,
    });
  }

  private dispatch(event: ChatEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        void logError("chat_bridge_handler_threw", fmtErr(err));
      }
    }
  }

  async createSession(args: CreateSessionArgs): Promise<{ sessionId: string }> {
    if (!this.initialized || !this.client) {
      throw new ChatBridgeInitError("ChatBridge.init() must be called first");
    }

    const result = await this.client.session.create({
      body: { title: args.title },
      ...(args.directory !== undefined
        ? { query: { directory: args.directory } }
        : {}),
    });

    const data = (result as { data?: { id?: string } }).data;
    const id = data?.id;
    if (!id) {
      throw new ChatBridgeInitError(
        `session.create returned no id: ${JSON.stringify(result)}`,
      );
    }
    return { sessionId: id };
  }

  async sendMessage(args: SendMessageArgs): Promise<void> {
    if (!this.initialized || !this.client) {
      throw new ChatBridgeInitError("ChatBridge.init() must be called first");
    }

    // 同一 sessionId への重複は前回を中断
    const previous = this.controllers.get(args.sessionId);
    if (previous) {
      previous.abort("superseded");
    }

    const controller = new AbortController();
    this.controllers.set(args.sessionId, controller);

    const model = args.model ?? this.defaultModel;

    try {
      await this.client.session.prompt({
        path: { id: args.sessionId },
        body: {
          parts: args.parts as never,
          ...(model ? { model } : {}),
        },
        signal: controller.signal,
      });
    } finally {
      // 自分自身が依然として最新のコントローラなら map から外す
      if (this.controllers.get(args.sessionId) === controller) {
        this.controllers.delete(args.sessionId);
      }
    }
  }

  onEvent(handler: ChatEventHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async abort(sessionId: string): Promise<void> {
    const controller = this.controllers.get(sessionId);
    if (controller) {
      controller.abort("user-abort");
      this.controllers.delete(sessionId);
    }
    if (this.client) {
      try {
        await this.client.session.abort({ path: { id: sessionId } });
      } catch (err) {
        void logError("chat_bridge_session_abort_failed", fmtErr(err));
      }
    }
    this.dispatch({
      type: "error",
      reason: "abort",
      sessionId,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    this.initialized = false;

    for (const c of this.controllers.values()) {
      try {
        c.abort("dispose");
      } catch {
        // best-effort
      }
    }
    this.controllers.clear();

    if (this.subscribeController) {
      try {
        this.subscribeController.abort("dispose");
      } catch {
        // best-effort
      }
    }

    // AsyncGenerator が abort signal を見ていない実装でも dispose を成立させるため
    // stream.return() で明示的に終了させる
    if (this.subscribeStream) {
      try {
        await this.subscribeStream.return();
      } catch {
        // ignore
      }
    }

    if (this.subscribeLoopPromise) {
      try {
        await this.subscribeLoopPromise;
      } catch {
        // ignore
      }
    }

    this.subscribeController = null;
    this.subscribeLoopPromise = null;
    this.subscribeStream = null;
    this.client = null;
    this.handlers.clear();
  }
}
