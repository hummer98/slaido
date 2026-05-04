import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PresetStore } from "./preset-store";
import { RubricStoreError, type DeckRubric } from "./rubric-types";

let workdir: string;
let presetsRoot: string;

function buildRubric(label: string): DeckRubric {
  return {
    schemaVersion: 1,
    axes: {
      audience: label,
      duration_min: 10,
      purpose: "教育",
      success_criteria: "ok",
      tone: null,
      anti_patterns: [],
    },
    raw_interview_log: [],
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "slaido-preset-store-"));
  presetsRoot = join(workdir, "rubric-presets");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("PresetStore.save", () => {
  it("save → 戻り値の id は UUID 形式 / name は trim 済", async () => {
    const store = new PresetStore(presetsRoot);
    const preset = await store.save({ name: "  社内 LT  ", rubric: buildRubric("a") });
    expect(preset.name).toBe("社内 LT");
    expect(preset.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(preset.rubric).toEqual(buildRubric("a"));
  });

  it("save: 空 name は INVALID_INPUT", async () => {
    const store = new PresetStore(presetsRoot);
    let caught: unknown;
    try {
      await store.save({ name: "   ", rubric: buildRubric("a") });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("INVALID_INPUT");
  });

  it("save: ファイル名は <id>.json (path traversal 用ユーザー入力なし)", async () => {
    const store = new PresetStore(presetsRoot);
    const preset = await store.save({ name: "x", rubric: buildRubric("a") });
    const entries = await readdir(presetsRoot);
    expect(entries).toEqual([`${preset.id}.json`]);
  });
});

describe("PresetStore.get", () => {
  it("save 後の get で同じ preset が戻る", async () => {
    const store = new PresetStore(presetsRoot);
    const saved = await store.save({ name: "a", rubric: buildRubric("a") });
    const got = await store.get(saved.id);
    expect(got).toEqual(saved);
  });

  it("get: 不在は RUBRIC_NOT_FOUND", async () => {
    const store = new PresetStore(presetsRoot);
    let caught: unknown;
    try {
      await store.get("nope");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("RUBRIC_NOT_FOUND");
  });

  it("get: 壊れた JSON は RUBRIC_CORRUPTED", async () => {
    await mkdir(presetsRoot, { recursive: true });
    await writeFile(join(presetsRoot, "broken.json"), "{not json", "utf8");
    const store = new PresetStore(presetsRoot);
    let caught: unknown;
    try {
      await store.get("broken");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("RUBRIC_CORRUPTED");
  });

  it("get: schema mismatch も RUBRIC_CORRUPTED", async () => {
    await mkdir(presetsRoot, { recursive: true });
    await writeFile(
      join(presetsRoot, "bad.json"),
      JSON.stringify({ id: "bad", name: "x" }),
      "utf8",
    );
    const store = new PresetStore(presetsRoot);
    let caught: unknown;
    try {
      await store.get("bad");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("RUBRIC_CORRUPTED");
  });
});

describe("PresetStore.list", () => {
  it("ディレクトリ不在では []", async () => {
    const store = new PresetStore(presetsRoot);
    expect(await store.list()).toEqual([]);
  });

  it("createdAt 降順で返す", async () => {
    const store = new PresetStore(presetsRoot);
    // 2 つ save し、ファイルの中身を直接書き換えて createdAt を制御
    const a = await store.save({ name: "older", rubric: buildRubric("a") });
    const b = await store.save({ name: "newer", rubric: buildRubric("b") });
    await writeFile(
      store.pathFor(a.id),
      JSON.stringify({ ...a, createdAt: "2026-01-01T00:00:00.000Z" }, null, 2),
      "utf8",
    );
    await writeFile(
      store.pathFor(b.id),
      JSON.stringify({ ...b, createdAt: "2026-05-04T00:00:00.000Z" }, null, 2),
      "utf8",
    );
    const list = await store.list();
    expect(list.map((p) => p.name)).toEqual(["newer", "older"]);
  });

  it("壊れた JSON / schema 不一致のファイルは skip される", async () => {
    const store = new PresetStore(presetsRoot);
    const ok = await store.save({ name: "ok", rubric: buildRubric("a") });
    await writeFile(join(presetsRoot, "bad-json.json"), "{garbage", "utf8");
    await writeFile(
      join(presetsRoot, "bad-schema.json"),
      JSON.stringify({ id: "x", name: "y" }),
      "utf8",
    );
    // *.json 以外のゴミも skip
    await writeFile(join(presetsRoot, "README.md"), "hi", "utf8");
    const list = await store.list();
    expect(list.map((p) => p.id)).toEqual([ok.id]);
  });
});

describe("PresetStore.delete", () => {
  it("delete 後は get で RUBRIC_NOT_FOUND", async () => {
    const store = new PresetStore(presetsRoot);
    const preset = await store.save({ name: "x", rubric: buildRubric("a") });
    await store.delete(preset.id);
    let caught: unknown;
    try {
      await store.get(preset.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("RUBRIC_NOT_FOUND");
  });

  it("delete: 元から存在しない id でも throw しない", async () => {
    const store = new PresetStore(presetsRoot);
    await mkdir(presetsRoot, { recursive: true });
    await store.delete("does-not-exist");
  });
});
