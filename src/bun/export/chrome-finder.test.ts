import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findChromium } from "./chrome-finder";

const ENV_KEY = "SLAIDO_CHROME_PATH";

async function makeTmpExecutable(name: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "slaido-chrome-"));
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
  return { dir, path };
}

describe("findChromium", () => {
  const previousEnv = process.env[ENV_KEY];
  let cleanupDirs: string[] = [];

  afterEach(async () => {
    if (previousEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previousEnv;

    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it("returns first existing path from candidatePaths (env unset)", async () => {
    delete process.env[ENV_KEY];
    const { dir, path } = await makeTmpExecutable("fake-chrome");
    cleanupDirs.push(dir);

    const result = await findChromium({
      candidatePaths: ["/nonexistent/path/Chrome", path],
    });

    expect(result).toBe(path);
  });

  it("returns null when neither env nor candidatePaths resolve to an existing file", async () => {
    delete process.env[ENV_KEY];
    const result = await findChromium({ candidatePaths: [] });
    expect(result).toBeNull();
  });

  it("env override takes precedence over candidatePaths (Critical C1)", async () => {
    const { dir: envDir, path: envPath } = await makeTmpExecutable("env-chrome");
    const { dir: candDir, path: candPath } = await makeTmpExecutable("cand-chrome");
    cleanupDirs.push(envDir, candDir);

    process.env[ENV_KEY] = envPath;

    const result = await findChromium({ candidatePaths: [candPath] });
    expect(result).toBe(envPath);
  });

  it("env override is ignored when the file does not exist", async () => {
    const { dir, path } = await makeTmpExecutable("cand-chrome");
    cleanupDirs.push(dir);

    process.env[ENV_KEY] = "/nonexistent/env/Chrome";

    const result = await findChromium({ candidatePaths: [path] });
    expect(result).toBe(path);
  });

  it("env-only mode: candidatePaths: [] + env set returns env path", async () => {
    const { dir, path } = await makeTmpExecutable("env-chrome");
    cleanupDirs.push(dir);

    process.env[ENV_KEY] = path;

    const result = await findChromium({ candidatePaths: [] });
    expect(result).toBe(path);
  });
});
