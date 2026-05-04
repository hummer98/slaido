/**
 * グローバル rubric preset store (T019 plan §2.7.2).
 *
 * - 保存先: `~/Library/Application Support/slAIdo/rubric-presets/<presetId>.json`
 * - presetId は **crypto.randomUUID()** を使う (path traversal 防止 — ユーザー入力は
 *   `name` 経由でのみ受け取り、ファイルパスには使わない)
 * - list / get では `RubricPresetSchema.safeParse` でバリデーションし、失敗時は
 *   list なら skip / get なら RUBRIC_CORRUPTED を throw (ProjectStore.list の
 *   META_CORRUPTED 処理と同パターン)
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  RubricPresetSchema,
  RubricStoreError,
  type DeckRubric,
  type RubricPreset,
} from "./rubric-types";

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
}

export interface SavePresetInput {
  name: string;
  rubric: DeckRubric;
}

export class PresetStore {
  constructor(private readonly presetsRoot: string) {}

  pathFor(presetId: string): string {
    return join(this.presetsRoot, `${presetId}.json`);
  }

  async save(input: SavePresetInput): Promise<RubricPreset> {
    const trimmed = input.name.trim();
    if (trimmed.length === 0) {
      throw new RubricStoreError("INVALID_INPUT", "preset name must not be empty");
    }
    const id = crypto.randomUUID();
    const preset: RubricPreset = {
      id,
      name: trimmed,
      rubric: input.rubric,
      createdAt: new Date().toISOString(),
    };
    const parsed = RubricPresetSchema.safeParse(preset);
    if (!parsed.success) {
      throw new RubricStoreError(
        "INVALID_INPUT",
        `preset schema mismatch: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    try {
      await mkdir(this.presetsRoot, { recursive: true });
      await writeFile(
        this.pathFor(id),
        `${JSON.stringify(parsed.data, null, 2)}\n`,
        "utf8",
      );
    } catch (err) {
      throw new RubricStoreError(
        "IO_ERROR",
        `save failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }
    return parsed.data;
  }

  async get(presetId: string): Promise<RubricPreset> {
    const path = this.pathFor(presetId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        throw new RubricStoreError(
          "RUBRIC_NOT_FOUND",
          `preset not found: ${presetId}`,
          { cause: err },
        );
      }
      throw new RubricStoreError(
        "IO_ERROR",
        `get failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new RubricStoreError(
        "RUBRIC_CORRUPTED",
        `invalid JSON: ${presetId}`,
        { cause: err },
      );
    }
    const parsed = RubricPresetSchema.safeParse(json);
    if (!parsed.success) {
      throw new RubricStoreError(
        "RUBRIC_CORRUPTED",
        `schema mismatch: ${presetId}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  async list(): Promise<RubricPreset[]> {
    let entries: string[];
    try {
      entries = await readdir(this.presetsRoot);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return [];
      throw new RubricStoreError(
        "IO_ERROR",
        `list failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }

    const presets: RubricPreset[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.presetsRoot, name);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = RubricPresetSchema.safeParse(json);
      if (!parsed.success) continue;
      presets.push(parsed.data);
    }

    presets.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return presets;
  }

  async delete(presetId: string): Promise<void> {
    try {
      await rm(this.pathFor(presetId), { force: true });
    } catch (err) {
      throw new RubricStoreError(
        "IO_ERROR",
        `delete failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }
  }
}
