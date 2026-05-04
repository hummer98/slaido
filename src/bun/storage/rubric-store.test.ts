import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RubricStore } from "./rubric-store";
import { RubricStoreError, type DeckRubric } from "./rubric-types";

let workdir: string;
let projectsRoot: string;

const PROJECT_ID = "proj-1";

function buildRubric(): DeckRubric {
  return {
    schemaVersion: 1,
    axes: {
      audience: "社内エンジニア",
      duration_min: 15,
      purpose: "教育",
      success_criteria: "聴衆が rubric の意味を 1 文で言える",
      tone: "落ち着いた",
      anti_patterns: ["Gamma っぽさ"],
    },
    raw_interview_log: [{ q: "誰に話す予定？", a: "社内エンジニア" }],
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "slaido-rubric-store-"));
  projectsRoot = join(workdir, "projects");
  await mkdir(join(projectsRoot, PROJECT_ID), { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("RubricStore.pathFor", () => {
  it("<projectsRoot>/<projectId>/rubric.json を返す純関数", () => {
    const store = new RubricStore("/tmp/projects");
    expect(store.pathFor("abc")).toBe("/tmp/projects/abc/rubric.json");
  });
});

describe("RubricStore.save / load", () => {
  it("save → load で同一 rubric が戻る", async () => {
    const store = new RubricStore(projectsRoot);
    const rubric = buildRubric();
    await store.save(PROJECT_ID, rubric);
    const loaded = await store.load(PROJECT_ID);
    expect(loaded).toEqual(rubric);
  });

  it("save: schema 違反は INVALID_INPUT を throw", async () => {
    const store = new RubricStore(projectsRoot);
    const broken = {
      schemaVersion: 1,
      axes: {
        audience: "x",
        duration_min: -1,
        purpose: "知らない",
        success_criteria: null,
        tone: null,
        anti_patterns: [],
      },
      raw_interview_log: [],
      createdAt: "now",
      updatedAt: "now",
    } as unknown as DeckRubric;
    let caught: unknown;
    try {
      await store.save(PROJECT_ID, broken);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("INVALID_INPUT");
  });

  it("save: rubric.json は JSON として再 parse 可能", async () => {
    const store = new RubricStore(projectsRoot);
    await store.save(PROJECT_ID, buildRubric());
    const raw = await readFile(store.pathFor(PROJECT_ID), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("load: ファイル不在は RUBRIC_NOT_FOUND", async () => {
    const store = new RubricStore(projectsRoot);
    let caught: unknown;
    try {
      await store.load(PROJECT_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("RUBRIC_NOT_FOUND");
  });

  it("load: 壊れた JSON は RUBRIC_CORRUPTED", async () => {
    const store = new RubricStore(projectsRoot);
    await writeFile(store.pathFor(PROJECT_ID), "{not valid json", "utf8");
    let caught: unknown;
    try {
      await store.load(PROJECT_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("RUBRIC_CORRUPTED");
  });

  it("load: schema mismatch も RUBRIC_CORRUPTED", async () => {
    const store = new RubricStore(projectsRoot);
    await writeFile(
      store.pathFor(PROJECT_ID),
      JSON.stringify({ schemaVersion: 2 }),
      "utf8",
    );
    let caught: unknown;
    try {
      await store.load(PROJECT_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("RUBRIC_CORRUPTED");
  });
});

describe("RubricStore.loadOrNull", () => {
  it("ファイル不在は null", async () => {
    const store = new RubricStore(projectsRoot);
    expect(await store.loadOrNull(PROJECT_ID)).toBeNull();
  });

  it("正常時は rubric を返す", async () => {
    const store = new RubricStore(projectsRoot);
    const rubric = buildRubric();
    await store.save(PROJECT_ID, rubric);
    expect(await store.loadOrNull(PROJECT_ID)).toEqual(rubric);
  });

  it("RUBRIC_CORRUPTED は throw する (非 NOT_FOUND)", async () => {
    const store = new RubricStore(projectsRoot);
    await writeFile(store.pathFor(PROJECT_ID), "{}", "utf8");
    let caught: unknown;
    try {
      await store.loadOrNull(PROJECT_ID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RubricStoreError);
    expect((caught as RubricStoreError).code).toBe("RUBRIC_CORRUPTED");
  });
});
