import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyRevealTemplate } from "./template-copier";
import { ProjectStoreError } from "./types";

const FIXTURE_TEMPLATE_ROOT = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "reveal-template");

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "slaido-tpl-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("copyRevealTemplate", () => {
  it("fixture テンプレを cwd 配下にコピーする", async () => {
    const dst = join(workdir, "proj");
    await mkdir(dst, { recursive: true });

    await copyRevealTemplate(FIXTURE_TEMPLATE_ROOT, dst);

    expect(existsSync(join(dst, "slides", "index.html"))).toBe(true);
    expect(existsSync(join(dst, "slides", "dist", "reveal.css"))).toBe(true);
    expect(existsSync(join(dst, "slides", "dist", "reveal.js"))).toBe(true);
    expect(existsSync(join(dst, "slides", "dist", "theme", "black.css"))).toBe(true);
    expect(existsSync(join(dst, "opencode.json"))).toBe(true);
    expect(existsSync(join(dst, "AGENTS.md"))).toBe(true);
  });

  it("ソースが空 / 必須ファイル不足だと TEMPLATE_MISSING を投げる", async () => {
    const fakeSrc = join(workdir, "fake-template");
    await mkdir(fakeSrc, { recursive: true });
    await writeFile(join(fakeSrc, "index.html"), "ok");

    const dst = join(workdir, "proj");
    await mkdir(dst, { recursive: true });

    let caught: unknown;
    try {
      await copyRevealTemplate(fakeSrc, dst);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectStoreError);
    expect((caught as ProjectStoreError).code).toBe("TEMPLATE_MISSING");
  });

  it("templateRoot 自体が存在しないと TEMPLATE_MISSING", async () => {
    const dst = join(workdir, "proj");
    await mkdir(dst, { recursive: true });

    let caught: unknown;
    try {
      await copyRevealTemplate(join(workdir, "does-not-exist"), dst);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectStoreError);
    expect((caught as ProjectStoreError).code).toBe("TEMPLATE_MISSING");
  });
});
