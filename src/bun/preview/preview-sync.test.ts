/**
 * PreviewSync の TDD テスト.
 *
 * Cycle 2 (lifecycle) → Cycle 3 (SSE) → Cycle 4 (chokidar 実 fs)
 * → Cycle 5 (重複排除) → Cycle 6 (ログ) → SSE 切断 / counters まとめ.
 *
 * design-review:
 *   - Finding 4: bun:test は既定で順次実行. afterEach で stop() を必ず呼ぶ
 *   - Finding 6: 状態×イベント表に従い不正遷移は throw
 *   - Finding 7: pending / firstSignalAt の reset は fire() に集約
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PreviewSync, type PreviewUpdateInfo } from "./preview-sync";
import type { ChatEvent, OpencodeToolState } from "../opencode/types";

// ---------------------------------------------------------------------------
// テスト用 helpers
// ---------------------------------------------------------------------------

interface TestEnv {
  cwd: string;
  slidesDir: string;
  slidesEntry: string;
  emitChatEvent: (e: ChatEvent) => void;
  unsubscribed: { value: boolean };
  cleanup: () => Promise<void>;
}

let envCounter = 0;

async function setupTestEnv(): Promise<TestEnv> {
  envCounter += 1;
  const cwd = join(tmpdir(), `slaido-t012-${process.pid}-${envCounter}-${Date.now()}`);
  const slidesDir = join(cwd, "slides");
  await mkdir(slidesDir, { recursive: true });
  const slidesEntry = join(slidesDir, "index.html");
  // 初期 HTML を 1 つ置く (ignoreInitial: true で発火されないこと前提)
  await writeFile(slidesEntry, "<html><body>v0</body></html>", "utf8");

  const handlers = new Set<(e: ChatEvent) => void>();
  const unsubscribed = { value: false };

  const emitChatEvent = (e: ChatEvent) => {
    for (const h of handlers) h(e);
  };

  const cleanup = async () => {
    await rm(cwd, { recursive: true, force: true });
  };

  // PreviewSync.start({ subscribeChatEvents }) に渡す関数を返すには env を返した側で組む
  return {
    cwd,
    slidesDir,
    slidesEntry,
    emitChatEvent,
    unsubscribed,
    cleanup,
  };

  // subscribeChatEvents は subscribe(handler) を保存しておく
}

function makeSubscribe(env: TestEnv) {
  const handlers = new Set<(e: ChatEvent) => void>();
  return {
    subscribe: (handler: (e: ChatEvent) => void) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        env.unsubscribed.value = true;
      };
    },
    emit: (e: ChatEvent) => {
      for (const h of handlers) h(e);
    },
  };
}

function makeToolStatus(args: {
  tool: string;
  status: "pending" | "running" | "completed";
  filePath?: string;
  inputKey?: "filePath" | "file_path" | "file" | "path";
}): ChatEvent {
  const inputKey = args.inputKey ?? "filePath";
  const input: Record<string, unknown> =
    args.filePath !== undefined ? { [inputKey]: args.filePath } : {};
  const state = { status: args.status, input } as unknown as OpencodeToolState;
  return {
    type: "tool-status",
    sessionId: "s1",
    messageId: "m1",
    partId: "p1",
    callId: "c1",
    tool: args.tool,
    state,
    raw: undefined as never,
  };
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Cycle 2: lifecycle
// ---------------------------------------------------------------------------

describe("PreviewSync lifecycle", () => {
  let env: TestEnv;
  let sync: PreviewSync;

  beforeEach(async () => {
    env = await setupTestEnv();
    sync = new PreviewSync({ debounceMs: 30, silent: true });
  });

  afterEach(async () => {
    await sync.stop();
    await env.cleanup();
  });

  test("status starts as 'idle'", () => {
    expect(sync.getStatus()).toBe("idle");
  });

  test("start transitions idle → running", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    expect(sync.getStatus()).toBe("running");
  });

  test("calling start twice while running throws", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    await expect(
      sync.start({
        projectId: "p1",
        cwd: env.cwd,
        slidesEntry: env.slidesEntry,
        subscribeChatEvents: sub.subscribe,
      }),
    ).rejects.toThrow(/already/i);
  });

  test("stop is idempotent", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    await sync.stop();
    await sync.stop(); // 2 度目は no-op
    expect(sync.getStatus()).toBe("stopped");
  });

  test("can re-start after stop", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    await sync.stop();
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    expect(sync.getStatus()).toBe("running");
  });

  test("stop unsubscribes SSE handler", async () => {
    const sub = makeSubscribe(env);
    await sync.start({
      projectId: "p1",
      cwd: env.cwd,
      slidesEntry: env.slidesEntry,
      subscribeChatEvents: sub.subscribe,
    });
    expect(env.unsubscribed.value).toBe(false);
    await sync.stop();
    expect(env.unsubscribed.value).toBe(true);
  });
});
