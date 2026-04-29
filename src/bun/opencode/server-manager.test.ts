/**
 * OpencodeServerManager の bun:test スイート (実バイナリ起動)
 *
 * skip 条件: OPENCODE_BIN 未設定 + bin/<arch>/opencode 不在の場合は skip
 *   → CI 未配備のため. ローカルでは fetchOpencode 後に実 run する.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { detectArch, resolveOpencodeBinary } from "./binary-resolver";
import { OpencodeServerManager } from "./server-manager";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function findBinaryPath(): string | null {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  try {
    const arch = detectArch();
    const path = resolve(REPO_ROOT, "bin", arch, "opencode");
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const binaryPath = findBinaryPath();
const describeIfBinary = binaryPath ? describe : describe.skip;

describeIfBinary("OpencodeServerManager (real binary)", () => {
  let manager: OpencodeServerManager | null = null;

  beforeAll(() => {
    if (!binaryPath) throw new Error("unreachable: skip should have been applied");
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
      manager = null;
    }
  });

  test("start → /global/health 200 → stop", async () => {
    manager = new OpencodeServerManager({
      binaryPath: binaryPath ?? undefined,
      stopGracePeriodMs: 2_000,
    });

    const info = await manager.start();
    expect(info.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(info.password).toHaveLength(64); // 32 bytes hex
    expect(info.username).toBe("opencode");
    expect(info.pid).toBeGreaterThan(0);
    expect(manager.getStatus()).toBe("running");

    const credentials = `${info.username}:${info.password}`;
    const auth = `Basic ${Buffer.from(credentials).toString("base64")}`;
    const res = await fetch(`${info.baseUrl}/global/health`, {
      headers: { Authorization: auth },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { healthy: boolean; version: string };
    expect(body.healthy).toBe(true);
    expect(body.version).toBe("1.14.29");

    await manager.stop();
    expect(manager.getStatus()).toBe("stopped");
    expect(manager.getInfo()).toBeNull();
  }, 30_000);

  test("start() is idempotent under concurrent calls", async () => {
    manager = new OpencodeServerManager({
      binaryPath: binaryPath ?? undefined,
      stopGracePeriodMs: 2_000,
    });
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    expect(a.baseUrl).toBe(b.baseUrl);
    expect(a.pid).toBe(b.pid);
  }, 30_000);

  test("stop() is idempotent", async () => {
    manager = new OpencodeServerManager({
      binaryPath: binaryPath ?? undefined,
      stopGracePeriodMs: 2_000,
    });
    await manager.start();
    await manager.stop();
    await manager.stop(); // no-throw
    expect(manager.getStatus()).toBe("stopped");
  }, 30_000);
});

describe("resolveOpencodeBinary (unit)", () => {
  test("override は最優先", () => {
    const path = resolveOpencodeBinary({
      override: "/custom/opencode",
      env: { OPENCODE_BIN: "/should/not/use" },
    });
    expect(path).toBe("/custom/opencode");
  });

  test("OPENCODE_BIN env が次点", () => {
    const path = resolveOpencodeBinary({
      env: { OPENCODE_BIN: "/from/env/opencode" },
    });
    expect(path).toBe("/from/env/opencode");
  });

  test("env も override も無ければ <baseDir>/bin/<arch>/opencode", () => {
    const path = resolveOpencodeBinary({
      baseDir: "/some/base",
      env: {},
    });
    expect(path).toMatch(/^\/some\/base\/bin\/darwin-(arm64|x64)\/opencode$/);
  });
});
