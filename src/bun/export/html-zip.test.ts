import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleStaging,
  sanitizeStagingDirName,
  verifyNoExternalRefs,
} from "./html-zip";

const FIXTURE_REVEAL_MINI = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "reveal-mini",
);

describe("sanitizeStagingDirName", () => {
  it("replaces / and : with _", () => {
    expect(sanitizeStagingDirName("a/b:c")).toBe("a_b_c");
  });

  it("falls back to 'presentation' when empty", () => {
    expect(sanitizeStagingDirName("")).toBe("presentation");
  });

  it("falls back to 'presentation' when stripped to nothing", () => {
    expect(sanitizeStagingDirName("///:::")).toBe("presentation");
  });
});

describe("assembleStaging", () => {
  let cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it("copies slides + dist into <staging>/<title>/ and writes README.txt", async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), "slaido-staging-"));
    cleanupDirs.push(stagingRoot);

    const result = await assembleStaging({
      srcSlidesDir: join(FIXTURE_REVEAL_MINI, "slides"),
      distDir: join(FIXTURE_REVEAL_MINI, "dist"),
      stagingRoot,
      title: "My Talk",
    });

    expect(result.rootDirName).toBe("My Talk");
    const root = join(stagingRoot, "My Talk");
    expect(await Bun.file(join(root, "index.html")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist", "reveal.js")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist", "reset.css")).exists()).toBe(true);
    expect(await Bun.file(join(root, "dist", "theme", "black.css")).exists()).toBe(true);
    expect(await Bun.file(join(root, "README.txt")).exists()).toBe(true);
  });

  it("scrubs .DS_Store / __MACOSX from staging (Critical C3)", async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), "slaido-staging-"));
    cleanupDirs.push(stagingRoot);

    // 元 slides に .DS_Store と __MACOSX を仕込む
    const dirtySlidesDir = await mkdtemp(join(tmpdir(), "slaido-dirty-"));
    cleanupDirs.push(dirtySlidesDir);
    await writeFile(join(dirtySlidesDir, "index.html"), "<!DOCTYPE html><html></html>", "utf8");
    await writeFile(join(dirtySlidesDir, ".DS_Store"), "macgarbage", "binary");
    await mkdir(join(dirtySlidesDir, "__MACOSX"), { recursive: true });
    await writeFile(join(dirtySlidesDir, "__MACOSX", "shadow"), "x", "utf8");
    await mkdir(join(dirtySlidesDir, "assets"), { recursive: true });
    await writeFile(join(dirtySlidesDir, "assets", ".DS_Store"), "x", "binary");

    await assembleStaging({
      srcSlidesDir: dirtySlidesDir,
      distDir: join(FIXTURE_REVEAL_MINI, "dist"),
      stagingRoot,
      title: "deck",
    });

    const root = join(stagingRoot, "deck");
    expect(await Bun.file(join(root, ".DS_Store")).exists()).toBe(false);
    expect(await Bun.file(join(root, "__MACOSX", "shadow")).exists()).toBe(false);
    expect(await Bun.file(join(root, "assets", ".DS_Store")).exists()).toBe(false);
    // 中身の妥当ファイルは残ること
    expect(await Bun.file(join(root, "index.html")).exists()).toBe(true);
  });

  it("sanitizes title with / and : in directory name", async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), "slaido-staging-"));
    cleanupDirs.push(stagingRoot);

    const result = await assembleStaging({
      srcSlidesDir: join(FIXTURE_REVEAL_MINI, "slides"),
      distDir: join(FIXTURE_REVEAL_MINI, "dist"),
      stagingRoot,
      title: "a/b:c",
    });

    expect(result.rootDirName).toBe("a_b_c");
    expect(await Bun.file(join(stagingRoot, "a_b_c", "index.html")).exists()).toBe(true);
  });
});

describe("verifyNoExternalRefs", () => {
  let cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it("returns ok=true when only relative refs exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slaido-vne-"));
    cleanupDirs.push(dir);
    const html = `<html><head><link rel="stylesheet" href="dist/reveal.css"></head><body><img src="assets/cat.png"></body></html>`;
    await writeFile(join(dir, "index.html"), html, "utf8");

    const result = await verifyNoExternalRefs(join(dir, "index.html"));
    expect(result.ok).toBe(true);
    expect(result.externalRefs).toEqual([]);
  });

  it("flags https:// CDN refs as external", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slaido-vne-"));
    cleanupDirs.push(dir);
    const html = `<link href="https://cdn.example.com/foo.css">`;
    await writeFile(join(dir, "index.html"), html, "utf8");

    const result = await verifyNoExternalRefs(join(dir, "index.html"));
    expect(result.ok).toBe(false);
    expect(result.externalRefs).toContain("https://cdn.example.com/foo.css");
  });

  it("flags protocol-relative // refs as external", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slaido-vne-"));
    cleanupDirs.push(dir);
    const html = `<script src="//cdn.example.com/bar.js"></script>`;
    await writeFile(join(dir, "index.html"), html, "utf8");

    const result = await verifyNoExternalRefs(join(dir, "index.html"));
    expect(result.ok).toBe(false);
    expect(result.externalRefs).toContain("//cdn.example.com/bar.js");
  });
});
