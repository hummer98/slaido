/**
 * 各プロジェクトの rubric.json を save/load する store (T019 plan §2.7.1).
 *
 * - 保存先: `<projectsRoot>/<projectId>/rubric.json`
 * - schemaVersion 1 を厳格にバリデート (DeckRubricSchema)
 * - load 時の異常は RubricStoreError に classify
 *   - ENOENT             → RUBRIC_NOT_FOUND
 *   - JSON.parse 失敗     → RUBRIC_CORRUPTED
 *   - schema mismatch    → RUBRIC_CORRUPTED
 *   - その他 IO         → IO_ERROR
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DeckRubricSchema,
  RubricStoreError,
  type DeckRubric,
} from "./rubric-types";

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
}

export class RubricStore {
  constructor(private readonly projectsRoot: string) {}

  pathFor(projectId: string): string {
    return join(this.projectsRoot, projectId, "rubric.json");
  }

  async save(projectId: string, rubric: DeckRubric): Promise<void> {
    const parsed = DeckRubricSchema.safeParse(rubric);
    if (!parsed.success) {
      throw new RubricStoreError(
        "INVALID_INPUT",
        `rubric schema mismatch: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    const path = this.pathFor(projectId);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
    } catch (err) {
      throw new RubricStoreError(
        "IO_ERROR",
        `save failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }
  }

  async load(projectId: string): Promise<DeckRubric> {
    const path = this.pathFor(projectId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        throw new RubricStoreError(
          "RUBRIC_NOT_FOUND",
          `rubric not found: ${projectId}`,
          { cause: err },
        );
      }
      throw new RubricStoreError(
        "IO_ERROR",
        `load failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new RubricStoreError(
        "RUBRIC_CORRUPTED",
        `invalid JSON: ${projectId}`,
        { cause: err },
      );
    }

    const parsed = DeckRubricSchema.safeParse(json);
    if (!parsed.success) {
      throw new RubricStoreError(
        "RUBRIC_CORRUPTED",
        `schema mismatch: ${projectId}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  async loadOrNull(projectId: string): Promise<DeckRubric | null> {
    try {
      return await this.load(projectId);
    } catch (err) {
      if (err instanceof RubricStoreError && err.code === "RUBRIC_NOT_FOUND") {
        return null;
      }
      throw err;
    }
  }
}
