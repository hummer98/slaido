/**
 * TranscriptLogger の bun:test スイート.
 *
 * `client.app.log({ body: { service, level, message, extra } })` への薄いラッパであり、
 * 1) baseExtra と perEventExtra の merge (後勝ち) と
 * 2) client 未初期化時の no-op + 1 度だけの warn と
 * 3) `app.log` reject 時の fire-and-forget 安全性 (throw しない) を中心に検証する.
 *
 * `../logger` (warn / fmtErr) は `mock.module` で差し替え, 呼び出し回数 / 引数を spy する.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";

const warnSpy = mock(async (_event: string, _detail?: string) => {});

mock.module("../logger", () => ({
  warn: warnSpy,
  fmtErr: (e: unknown) =>
    `err=${JSON.stringify((e as Error)?.message ?? String(e))}`,
}));

const { TranscriptLogger, hashSeed, buildBaseExtra } = await import("./transcript");

type AppLogCall = {
  body?: {
    service?: string;
    level?: string;
    message?: string;
    extra?: Record<string, unknown>;
  };
};

type FakeClient = {
  app: {
    log: ReturnType<typeof mock>;
  };
};

function makeClient(opts: { reject?: unknown } = {}): FakeClient {
  return {
    app: {
      log: mock(async (_args: AppLogCall) => {
        if (opts.reject !== undefined) {
          throw opts.reject;
        }
        return { data: true };
      }),
    },
  };
}

beforeEach(() => {
  warnSpy.mockClear();
});

describe("TranscriptLogger.log", () => {
  test("service=slaido / level=info / message=event / extra={...baseExtra, ...perEventExtra} で app.log が呼ばれる", async () => {
    const client = makeClient();
    const baseExtra = { slaidoVersion: "0.1.0", slaidoChannel: "dev" };
    const tl = new TranscriptLogger({
      getClient: () => client as never,
      baseExtra,
    });

    tl.log("slaido_generate_start", { projectId: "p1" });

    // fire-and-forget: microtask flush
    await Promise.resolve();
    await Promise.resolve();

    expect(client.app.log).toHaveBeenCalledTimes(1);
    const args = client.app.log.mock.calls[0]?.[0] as AppLogCall;
    expect(args.body?.service).toBe("slaido");
    expect(args.body?.level).toBe("info");
    expect(args.body?.message).toBe("slaido_generate_start");
    expect(args.body?.extra).toEqual({
      slaidoVersion: "0.1.0",
      slaidoChannel: "dev",
      projectId: "p1",
    });
  });

  test("baseExtra と perEventExtra の同名キーは perEventExtra が勝つ", async () => {
    const client = makeClient();
    const tl = new TranscriptLogger({
      getClient: () => client as never,
      baseExtra: { slaidoChannel: "dev", projectId: "BASE" },
    });

    tl.log("ev", { projectId: "OVERRIDE" });
    await Promise.resolve();
    await Promise.resolve();

    const args = client.app.log.mock.calls[0]?.[0] as AppLogCall;
    expect(args.body?.extra?.projectId).toBe("OVERRIDE");
    expect(args.body?.extra?.slaidoChannel).toBe("dev");
  });
});

describe("TranscriptLogger.error", () => {
  test("level=error / extra.errMessage=err.message / extra.errStack(truncate) を含めて呼ばれる", async () => {
    const client = makeClient();
    const tl = new TranscriptLogger({
      getClient: () => client as never,
      baseExtra: {},
    });

    const err = new Error("boom");
    tl.error("slaido_generate_failed", err);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.app.log).toHaveBeenCalledTimes(1);
    const args = client.app.log.mock.calls[0]?.[0] as AppLogCall;
    expect(args.body?.level).toBe("error");
    expect(args.body?.message).toBe("slaido_generate_failed");
    expect(args.body?.extra?.errMessage).toBe("boom");
    expect(typeof args.body?.extra?.errStack).toBe("string");
    expect((args.body?.extra?.errStack as string).length).toBeLessThanOrEqual(800);
  });

  test("error() の extra も merge される (errMessage / errStack の上書きはしない)", async () => {
    const client = makeClient();
    const tl = new TranscriptLogger({
      getClient: () => client as never,
      baseExtra: { slaidoVersion: "0.1.0" },
    });

    tl.error("slaido_generate_failed", new Error("boom"), {
      projectId: "p1",
      durationMs: 42,
    });
    await Promise.resolve();
    await Promise.resolve();

    const args = client.app.log.mock.calls[0]?.[0] as AppLogCall;
    expect(args.body?.extra?.slaidoVersion).toBe("0.1.0");
    expect(args.body?.extra?.projectId).toBe("p1");
    expect(args.body?.extra?.durationMs).toBe(42);
    expect(args.body?.extra?.errMessage).toBe("boom");
  });
});

describe("TranscriptLogger: client 未初期化", () => {
  test("getClient() が null を返すと app.log は呼ばれず warn が 1 度だけ", async () => {
    const tl = new TranscriptLogger({
      getClient: () => null,
      baseExtra: {},
    });

    tl.log("slaido_started", { phase: "start" });
    tl.log("slaido_generate_start", { projectId: "p1" });
    tl.log("slaido_generate_end", { projectId: "p1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const callArgs = warnSpy.mock.calls[0];
    expect(callArgs?.[0]).toBe("transcript_log_failed");
    expect(String(callArgs?.[1])).toContain("client_unavailable");
  });
});

describe("TranscriptLogger: app.log reject 時の fire-and-forget 安全性", () => {
  test("reject されても throw せず, warn が呼ばれる", async () => {
    const client = makeClient({ reject: new Error("network down") });
    const tl = new TranscriptLogger({
      getClient: () => client as never,
      baseExtra: {},
    });

    expect(() => tl.log("slaido_generate_start", { projectId: "p1" })).not.toThrow();
    // microtask + macrotask flush (catch handler は次の tick で動く)
    await new Promise((r) => setTimeout(r, 5));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toBe("transcript_log_failed");
    expect(String(warnSpy.mock.calls[0]?.[1])).toContain("slaido_generate_start");
  });
});

describe("hashSeed", () => {
  test('sha256("hello world") の hex 先頭 12 文字を返す', () => {
    expect(hashSeed("hello world")).toBe("b94d27b9934d");
  });

  test('hashSeed("") は sha256("") の先頭 12 文字 (e3b0c44298fc)', () => {
    expect(hashSeed("")).toBe("e3b0c44298fc");
  });
});

describe("buildBaseExtra", () => {
  test("slaidoVersion / buildSha / slaidoProcessId / slaidoChannel の 4 キーを必ず含む", () => {
    const extra = buildBaseExtra();
    expect(extra).toHaveProperty("slaidoVersion");
    expect(extra).toHaveProperty("buildSha");
    expect(extra).toHaveProperty("slaidoProcessId");
    expect(extra).toHaveProperty("slaidoChannel");
    expect(typeof extra.slaidoVersion).toBe("string");
    expect(typeof extra.slaidoProcessId).toBe("number");
  });
});
