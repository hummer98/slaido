/**
 * KeychainAdapter テスト
 *
 * - macOS: 専用 service 名 (`dev.slaido.test.<random>`) で 1 ケース統合テスト
 * - Linux/CI: skip (env fallback と KeychainUnsupportedError の挙動はモック platform で別途確認)
 *
 * `securityBin` オプションでテスト用 stub CLI スクリプトに差し替え、
 * exit code (0 / 44 / その他) と stdout を制御する。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  KeychainAccessError,
  KeychainAdapter,
  KeychainUnsupportedError,
} from "./keychain";

let stubDir: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "slaido-keychain-test-"));
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

/**
 * `security` 互換の stub スクリプトを生成して path を返す。
 *
 * Bun.spawn は実行可能ファイルを `cmd[0]` に指定する想定なので shell script を使う。
 */
function makeStub(args: {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}): string {
  const id = randomBytes(8).toString("hex");
  const path = join(stubDir, `security-stub-${id}.sh`);
  // shell の echo は \n をリテラル印字するシェル/環境差があるため、
  // ヒアドキュメント (`<<EOF`) に直接書き込んで cat で吐く。
  // ヒアドキュメントは末尾に必ず改行 + 終端マーカーが必要 (=最後に "" を残す split-join)
  const stdoutBody = args.stdout?.endsWith("\n")
    ? args.stdout.replace(/\n$/, "")
    : args.stdout;
  const stderrBody = args.stderr?.endsWith("\n")
    ? args.stderr.replace(/\n$/, "")
    : args.stderr;
  const writeStdout =
    args.stdout != null
      ? `cat <<'__SLAIDO_STUB_STDOUT_EOF__'\n${stdoutBody}\n__SLAIDO_STUB_STDOUT_EOF__`
      : ":";
  const writeStderr =
    args.stderr != null
      ? `cat <<'__SLAIDO_STUB_STDERR_EOF__' >&2\n${stderrBody}\n__SLAIDO_STUB_STDERR_EOF__`
      : ":";
  const script = `#!/bin/sh
${writeStdout}
${writeStderr}
exit ${args.exitCode}
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe("KeychainAdapter (stub security CLI)", () => {
  describe("getApiKey", () => {
    test("exit 0 → stdout を trim して返す", async () => {
      const stub = makeStub({ exitCode: 0, stdout: "sk-or-v1-abc123\n" });
      const adapter = new KeychainAdapter({ securityBin: stub, platform: "darwin" });
      const key = await adapter.getApiKey();
      expect(key).toBe("sk-or-v1-abc123");
    });

    test("exit 44 (errSecItemNotFound) → null", async () => {
      const stub = makeStub({ exitCode: 44, stderr: "not found" });
      const adapter = new KeychainAdapter({ securityBin: stub, platform: "darwin" });
      const key = await adapter.getApiKey();
      expect(key).toBeNull();
    });

    test("exit が 0 / 44 以外 → KeychainAccessError", async () => {
      const stub = makeStub({ exitCode: 1, stderr: "unknown failure" });
      const adapter = new KeychainAdapter({ securityBin: stub, platform: "darwin" });
      await expect(adapter.getApiKey()).rejects.toBeInstanceOf(KeychainAccessError);
    });
  });

  describe("setApiKey", () => {
    test("exit 0 → resolve", async () => {
      const stub = makeStub({ exitCode: 0 });
      const adapter = new KeychainAdapter({ securityBin: stub, platform: "darwin" });
      await expect(adapter.setApiKey("sk-or-v1-abc123")).resolves.toBeUndefined();
    });

    test("exit が 0 以外 → KeychainAccessError", async () => {
      const stub = makeStub({ exitCode: 1, stderr: "denied" });
      const adapter = new KeychainAdapter({ securityBin: stub, platform: "darwin" });
      await expect(adapter.setApiKey("sk-or-v1-abc123")).rejects.toBeInstanceOf(
        KeychainAccessError,
      );
    });
  });

  describe("deleteApiKey", () => {
    test("exit 0 → resolve", async () => {
      const stub = makeStub({ exitCode: 0 });
      const adapter = new KeychainAdapter({ securityBin: stub, platform: "darwin" });
      await expect(adapter.deleteApiKey()).resolves.toBeUndefined();
    });

    test("exit 44 → resolve (not-found は no-op)", async () => {
      const stub = makeStub({ exitCode: 44 });
      const adapter = new KeychainAdapter({ securityBin: stub, platform: "darwin" });
      await expect(adapter.deleteApiKey()).resolves.toBeUndefined();
    });

    test("exit が 0 / 44 以外 → KeychainAccessError", async () => {
      const stub = makeStub({ exitCode: 1, stderr: "denied" });
      const adapter = new KeychainAdapter({ securityBin: stub, platform: "darwin" });
      await expect(adapter.deleteApiKey()).rejects.toBeInstanceOf(KeychainAccessError);
    });
  });
});

describe("KeychainAdapter (non-darwin)", () => {
  const SAVED_ENV = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (SAVED_ENV === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = SAVED_ENV;
    }
  });

  test("getApiKey: env fallback ありなら値を返す", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-from-env";
    const adapter = new KeychainAdapter({ platform: "linux" });
    const key = await adapter.getApiKey();
    expect(key).toBe("sk-or-v1-from-env");
  });

  test("getApiKey: env 未設定なら null", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const adapter = new KeychainAdapter({ platform: "linux" });
    const key = await adapter.getApiKey();
    expect(key).toBeNull();
  });

  test("setApiKey: KeychainUnsupportedError を投げる", async () => {
    const adapter = new KeychainAdapter({ platform: "linux" });
    await expect(adapter.setApiKey("sk-or-v1-xxx")).rejects.toBeInstanceOf(
      KeychainUnsupportedError,
    );
  });

  test("deleteApiKey: KeychainUnsupportedError を投げる", async () => {
    const adapter = new KeychainAdapter({ platform: "linux" });
    await expect(adapter.deleteApiKey()).rejects.toBeInstanceOf(
      KeychainUnsupportedError,
    );
  });

  test("envFallbackKey でキー名を上書きできる", async () => {
    process.env.SLAIDO_TEST_KEY = "alt-key";
    const adapter = new KeychainAdapter({
      platform: "linux",
      envFallbackKey: "SLAIDO_TEST_KEY",
    });
    const key = await adapter.getApiKey();
    expect(key).toBe("alt-key");
    delete process.env.SLAIDO_TEST_KEY;
  });
});

const describeIfMacOS = process.platform === "darwin" ? describe : describe.skip;

describeIfMacOS("KeychainAdapter (real macOS Keychain)", () => {
  const service = `dev.slaido.test.${randomBytes(6).toString("hex")}`;
  const account = "openrouter";

  let adapter: KeychainAdapter;

  beforeAll(() => {
    adapter = new KeychainAdapter({ service, account, platform: "darwin" });
  });

  afterAll(async () => {
    try {
      await adapter.deleteApiKey();
    } catch {
      // best-effort cleanup
    }
  });

  test("set → get → delete のラウンドトリップ", async () => {
    const key = `sk-or-test-${randomBytes(8).toString("hex")}`;

    await adapter.setApiKey(key);
    const got = await adapter.getApiKey();
    expect(got).toBe(key);

    await adapter.deleteApiKey();
    const after = await adapter.getApiKey();
    expect(after).toBeNull();
  }, 15_000);

  test("setApiKey は上書きできる", async () => {
    const a = `sk-or-test-${randomBytes(8).toString("hex")}`;
    const b = `sk-or-test-${randomBytes(8).toString("hex")}`;

    await adapter.setApiKey(a);
    await adapter.setApiKey(b);
    expect(await adapter.getApiKey()).toBe(b);

    await adapter.deleteApiKey();
  }, 15_000);
});
