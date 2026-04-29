/**
 * key-validator 単体テスト
 *
 * - mock fetch で 200/401/429/5xx/network reject/AbortError (timeout) を網羅
 * - writeMinimalConfigForValidation の cp 動作確認
 * - maskApiKey のフォーマット確認
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KeyValidationError,
  maskApiKey,
  validateApiKey,
  writeMinimalConfigForValidation,
} from "./key-validator";
import type { OpencodeServerInfo } from "../opencode/server-manager";

function makeServerInfo(): OpencodeServerInfo {
  return {
    baseUrl: "http://127.0.0.1:1",
    password: "pw",
    username: "opencode",
    pid: 12345,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * 順次レスポンスを返す mock fetch を生成する。
 *
 * 各 fetch 呼び出しで responses[i] が返る。i がレスポンス数を超えた場合は
 * fallback (200, body: {}) を返す。
 */
function makeMockFetch(
  responses: Array<
    | { status: number; body?: unknown }
    | { throws: Error }
  >,
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === "object") {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    if (init?.signal?.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    calls.push({ url, method, headers, body });
    const next = responses[i++];
    if (!next) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if ("throws" in next) {
      throw next.throws;
    }
    const bodyStr =
      next.body == null ? "{}" : JSON.stringify(next.body);
    return new Response(bodyStr, {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("maskApiKey", () => {
  test("8 文字以下は全部マスク", () => {
    expect(maskApiKey("short")).toBe("***");
    expect(maskApiKey("12345678")).toBe("***");
  });

  test("先頭 8 文字を残して **", () => {
    expect(maskApiKey("sk-or-v1-abcdef123")).toBe("sk-or-v1**");
  });
});

describe("validateApiKey", () => {
  test("200 → resolve、/session 作成 + /prompt 送信 + DELETE", async () => {
    const mock = makeMockFetch([
      { status: 200, body: { id: "sess-1" } },           // POST /session
      { status: 200, body: { ok: true } },                // POST /session/{id}/prompt
      { status: 200, body: {} },                          // DELETE /session/{id}
    ]);
    await validateApiKey({
      serverInfo: makeServerInfo(),
      fetchImpl: mock.fetch,
    });
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[0]!.method).toBe("POST");
    expect(mock.calls[0]!.url).toBe("http://127.0.0.1:1/session");
    expect(mock.calls[1]!.method).toBe("POST");
    expect(mock.calls[1]!.url).toBe("http://127.0.0.1:1/session/sess-1/prompt");
    expect(mock.calls[1]!.body).toEqual({
      parts: [{ type: "text", text: "ping" }],
      model: { providerID: "openrouter", modelID: "anthropic/claude-haiku-4.5" },
    });
    // Authorization header (Basic auth) が付与されている
    expect(mock.calls[1]!.headers["Authorization"] ?? mock.calls[1]!.headers["authorization"])
      .toMatch(/^Basic /);
    expect(mock.calls[2]!.method).toBe("DELETE");
  });

  test("/prompt が 401 → KeyValidationError(unauthorized)", async () => {
    const mock = makeMockFetch([
      { status: 200, body: { id: "sess-1" } },
      { status: 401, body: { error: "invalid key" } },
      { status: 200, body: {} },                          // best-effort delete
    ]);
    try {
      await validateApiKey({
        serverInfo: makeServerInfo(),
        fetchImpl: mock.fetch,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeyValidationError);
      const e = err as KeyValidationError;
      expect(e.reason).toBe("unauthorized");
      expect(e.httpStatus).toBe(401);
    }
  });

  test("/prompt が 403 → unauthorized", async () => {
    const mock = makeMockFetch([
      { status: 200, body: { id: "sess-1" } },
      { status: 403, body: { error: "forbidden" } },
      { status: 200, body: {} },
    ]);
    try {
      await validateApiKey({
        serverInfo: makeServerInfo(),
        fetchImpl: mock.fetch,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeyValidationError);
      expect((err as KeyValidationError).reason).toBe("unauthorized");
    }
  });

  test("/prompt が 429 → rate_limit", async () => {
    const mock = makeMockFetch([
      { status: 200, body: { id: "sess-1" } },
      { status: 429, body: { error: "rate limit" } },
      { status: 200, body: {} },
    ]);
    try {
      await validateApiKey({
        serverInfo: makeServerInfo(),
        fetchImpl: mock.fetch,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeyValidationError);
      expect((err as KeyValidationError).reason).toBe("rate_limit");
    }
  });

  test("/prompt が 500 → unknown", async () => {
    const mock = makeMockFetch([
      { status: 200, body: { id: "sess-1" } },
      { status: 500, body: { error: "server error" } },
      { status: 200, body: {} },
    ]);
    try {
      await validateApiKey({
        serverInfo: makeServerInfo(),
        fetchImpl: mock.fetch,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeyValidationError);
      expect((err as KeyValidationError).reason).toBe("unknown");
    }
  });

  test("/session が 5xx → unknown", async () => {
    const mock = makeMockFetch([{ status: 503 }]);
    try {
      await validateApiKey({
        serverInfo: makeServerInfo(),
        fetchImpl: mock.fetch,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeyValidationError);
      expect((err as KeyValidationError).reason).toBe("unknown");
    }
  });

  test("fetch reject (network) → network", async () => {
    const mock = makeMockFetch([
      { throws: new TypeError("network error") },
    ]);
    try {
      await validateApiKey({
        serverInfo: makeServerInfo(),
        fetchImpl: mock.fetch,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeyValidationError);
      expect((err as KeyValidationError).reason).toBe("network");
    }
  });

  test("AbortError (timeout) → network 扱い", async () => {
    const mock = makeMockFetch([
      { status: 200, body: { id: "sess-1" } },
      { throws: Object.assign(new Error("aborted"), { name: "AbortError" }) },
      { status: 200, body: {} },
    ]);
    try {
      await validateApiKey({
        serverInfo: makeServerInfo(),
        fetchImpl: mock.fetch,
        timeoutMs: 50,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeyValidationError);
      const e = err as KeyValidationError;
      expect(e.reason).toBe("network");
      expect(e.message).toMatch(/timeout|aborted/i);
    }
  });

  test("DELETE が失敗しても resolve は維持される", async () => {
    const mock = makeMockFetch([
      { status: 200, body: { id: "sess-1" } },
      { status: 200, body: { ok: true } },
      { throws: new Error("delete failed") },             // best-effort
    ]);
    await expect(
      validateApiKey({
        serverInfo: makeServerInfo(),
        fetchImpl: mock.fetch,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("writeMinimalConfigForValidation", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  test("テンプレ root から opencode.json を cwd 直下にコピー", async () => {
    cwd = mkdtempSync(join(tmpdir(), "slaido-validate-cwd-"));
    rmSync(cwd, { recursive: true, force: true });

    // 仮のテンプレ root を作成 (実環境では assets/templates/reveal が使われる)
    const fakeRoot = mkdtempSync(join(tmpdir(), "slaido-validate-root-"));
    const sourceConfig = '{"$schema":"https://opencode.ai/config.json"}';
    writeFileSync(join(fakeRoot, "opencode.json"), sourceConfig);

    try {
      await writeMinimalConfigForValidation(cwd, fakeRoot);
      const copied = readFileSync(join(cwd, "opencode.json"), "utf8");
      expect(copied).toBe(sourceConfig);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  test("テンプレ root 未指定なら getBundledTemplateRoot() を使う", async () => {
    cwd = mkdtempSync(join(tmpdir(), "slaido-validate-cwd-"));
    rmSync(cwd, { recursive: true, force: true });

    await writeMinimalConfigForValidation(cwd);
    const copied = readFileSync(join(cwd, "opencode.json"), "utf8");
    // T014 の opencode.json が読めるはず
    expect(copied).toContain("openrouter");
    expect(copied).toContain("OPENROUTER_API_KEY");
  });

  test("既存ディレクトリを再利用する (mkdir recursive: true)", async () => {
    cwd = mkdtempSync(join(tmpdir(), "slaido-validate-cwd-"));
    // cwd は既に存在する状態
    const fakeRoot = mkdtempSync(join(tmpdir(), "slaido-validate-root-"));
    writeFileSync(join(fakeRoot, "opencode.json"), "{}");
    try {
      await expect(writeMinimalConfigForValidation(cwd, fakeRoot)).resolves
        .toBeUndefined();
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
