import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectStore } from "./project-store";
import { ProjectStoreError } from "./types";

const FIXTURE_TEMPLATE_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "reveal-template",
);

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let workdir: string;
let projectsRoot: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "slaido-store-"));
  projectsRoot = join(workdir, "projects");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("ProjectStore.getCwd", () => {
  it("projectId から projectsRoot/<id> を返す純関数", () => {
    const store = new ProjectStore("/tmp/projects-root", "/tmp/template-root");
    expect(store.getCwd("abc-123")).toBe("/tmp/projects-root/abc-123");
  });
});

describe("ProjectStore.create", () => {
  it("ディレクトリ構造とテンプレが期待通り、meta.json が読める", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    const project = await store.create({
      title: "My Deck",
      seedText: "hello seed",
    });

    expect(UUID_V4_RE.test(project.meta.id)).toBe(true);
    expect(project.meta.title).toBe("My Deck");
    expect(project.meta.schemaVersion).toBe(1);
    expect(project.meta.createdAt).toBe(project.meta.updatedAt);
    expect(project.cwd).toBe(join(projectsRoot, project.meta.id));
    expect(project.slidesEntry).toBe(join(project.cwd, "slides", "index.html"));

    expect(existsSync(join(project.cwd, "slides", "index.html"))).toBe(true);
    expect(existsSync(join(project.cwd, "slides", "dist", "reveal.css"))).toBe(true);
    expect(existsSync(join(project.cwd, "slides", "dist", "reveal.js"))).toBe(true);
    expect(existsSync(join(project.cwd, "slides", "dist", "theme", "black.css"))).toBe(true);
    expect(existsSync(join(project.cwd, "opencode.json"))).toBe(true);
    expect(existsSync(join(project.cwd, "AGENTS.md"))).toBe(true);

    const seed = await readFile(join(project.cwd, "seed", "input.md"), "utf8");
    expect(seed).toBe("hello seed");

    const meta = JSON.parse(
      await readFile(join(project.cwd, "meta.json"), "utf8"),
    );
    expect(meta.id).toBe(project.meta.id);
    expect(meta.schemaVersion).toBe(1);
  });

  it("空タイトル / whitespace のみは INVALID_TITLE", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);

    for (const bad of ["", "   ", "\t\n"]) {
      let caught: unknown;
      try {
        await store.create({ title: bad, seedText: "x" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProjectStoreError);
      expect((caught as ProjectStoreError).code).toBe("INVALID_TITLE");
    }
  });

  it("templateRoot 不在 / 必須ファイル不足は TEMPLATE_MISSING で fail-fast、半端ディレクトリも残らない", async () => {
    const store = new ProjectStore(projectsRoot, join(workdir, "no-such-template"));

    let caught: unknown;
    try {
      await store.create({ title: "X", seedText: "" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectStoreError);
    expect((caught as ProjectStoreError).code).toBe("TEMPLATE_MISSING");

    if (existsSync(projectsRoot)) {
      const remaining = await readdir(projectsRoot);
      expect(remaining).toEqual([]);
    }
  });

  it("不完全テンプレでも write 失敗時に半端ディレクトリは残らない", async () => {
    const incompleteTpl = join(workdir, "incomplete-template");
    await mkdir(incompleteTpl, { recursive: true });
    await writeFile(join(incompleteTpl, "index.html"), "ok");

    const store = new ProjectStore(projectsRoot, incompleteTpl);
    let caught: unknown;
    try {
      await store.create({ title: "Y", seedText: "" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectStoreError);

    if (existsSync(projectsRoot)) {
      const remaining = await readdir(projectsRoot);
      expect(remaining).toEqual([]);
    }
  });
});

describe("ProjectStore.load", () => {
  it("create で書いた meta を読み戻せる", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    const created = await store.create({ title: "Saved", seedText: "seed-x" });

    const loaded = await store.load(created.meta.id);
    expect(loaded.meta.id).toBe(created.meta.id);
    expect(loaded.meta.title).toBe("Saved");
    expect(loaded.meta.schemaVersion).toBe(1);
    expect(loaded.cwd).toBe(created.cwd);
    expect(loaded.slidesEntry).toBe(created.slidesEntry);
  });

  it("未知 ID は PROJECT_NOT_FOUND", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    let caught: unknown;
    try {
      await store.load("00000000-0000-4000-8000-000000000000");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectStoreError);
    expect((caught as ProjectStoreError).code).toBe("PROJECT_NOT_FOUND");
  });

  it("meta.json が JSON 不正 → META_CORRUPTED", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    const project = await store.create({ title: "broken", seedText: "" });
    await writeFile(join(project.cwd, "meta.json"), "{ not json", "utf8");

    let caught: unknown;
    try {
      await store.load(project.meta.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectStoreError);
    expect((caught as ProjectStoreError).code).toBe("META_CORRUPTED");
  });

  it("schemaVersion が 1 以外 → META_CORRUPTED", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    const project = await store.create({ title: "future", seedText: "" });
    await writeFile(
      join(project.cwd, "meta.json"),
      JSON.stringify({ ...project.meta, schemaVersion: 2 }),
      "utf8",
    );

    let caught: unknown;
    try {
      await store.load(project.meta.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectStoreError);
    expect((caught as ProjectStoreError).code).toBe("META_CORRUPTED");
  });
});

describe("ProjectStore.list", () => {
  it("projectsRoot 不在は空配列", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it("updatedAt 降順で返る", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    const a = await store.create({ title: "A", seedText: "" });
    const b = await store.create({ title: "B", seedText: "" });
    const c = await store.create({ title: "C", seedText: "" });

    const overwriteUpdatedAt = async (cwd: string, iso: string) => {
      const meta = JSON.parse(await readFile(join(cwd, "meta.json"), "utf8"));
      meta.updatedAt = iso;
      await writeFile(join(cwd, "meta.json"), JSON.stringify(meta));
    };
    await overwriteUpdatedAt(a.cwd, "2026-01-02T00:00:00.000Z");
    await overwriteUpdatedAt(b.cwd, "2026-01-03T00:00:00.000Z");
    await overwriteUpdatedAt(c.cwd, "2026-01-01T00:00:00.000Z");

    const list = await store.list();
    expect(list.map((p) => p.meta.title)).toEqual(["B", "A", "C"]);
  });

  it("meta.json 欠損ディレクトリはスキップ", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    await store.create({ title: "ok", seedText: "" });

    const orphan = join(projectsRoot, "orphan-dir");
    await mkdir(orphan, { recursive: true });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.meta.title).toBe("ok");
  });
});

describe("ProjectStore.delete", () => {
  it("create したものを削除できる", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    const project = await store.create({ title: "to-delete", seedText: "" });

    await store.delete(project.meta.id);
    expect(existsSync(project.cwd)).toBe(false);
  });

  it("再 delete は冪等", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    const project = await store.create({ title: "x", seedText: "" });
    await store.delete(project.meta.id);
    await store.delete(project.meta.id);
  });

  it("未知 ID は no-op", async () => {
    const store = new ProjectStore(projectsRoot, FIXTURE_TEMPLATE_ROOT);
    await store.delete("00000000-0000-4000-8000-000000000000");
  });
});
