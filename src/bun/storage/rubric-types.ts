/**
 * rubric の型定義 (T019 plan §2.6).
 *
 * - 内部 6 軸 (audience, duration_min, purpose, success_criteria, tone, anti_patterns)
 *   は **コード上の internal field name** であり UI ラベルとして直接出さない
 *   (A004 §「軸はユーザーには直接見せない」). UI / 生成 prompt は本ファイル末尾の
 *   `AXIS_LABELS_JA` (SSOT) で日本語ラベルに対応付ける
 * - schemaVersion は ProjectMetaSchema と同じく z.literal(1) で初期値を持たせる
 *   (将来後方互換移行コストを下げるため)
 */

import { z } from "zod";

export const DeckRubricAxesSchema = z.object({
  audience: z.string().nullable(),
  duration_min: z.number().int().positive().nullable(),
  purpose: z.enum(["説得", "共有", "教育", "提案承認"]).nullable(),
  success_criteria: z.string().nullable(),
  tone: z.string().nullable(),
  anti_patterns: z.array(z.string()),
});

export const RubricInterviewTurnSchema = z.object({
  q: z.string(),
  a: z.string(),
});

export const DeckRubricSchema = z.object({
  schemaVersion: z.literal(1),
  axes: DeckRubricAxesSchema,
  raw_interview_log: z.array(RubricInterviewTurnSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const RubricPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rubric: DeckRubricSchema,
  createdAt: z.string().min(1),
});

export type DeckRubricAxes = z.infer<typeof DeckRubricAxesSchema>;
export type RubricInterviewTurn = z.infer<typeof RubricInterviewTurnSchema>;
export type DeckRubric = z.infer<typeof DeckRubricSchema>;
export type RubricPreset = z.infer<typeof RubricPresetSchema>;

export type RubricStoreErrorCode =
  | "RUBRIC_NOT_FOUND"
  | "RUBRIC_CORRUPTED"
  | "INVALID_INPUT"
  | "IO_ERROR";

export class RubricStoreError extends Error {
  readonly code: RubricStoreErrorCode;
  constructor(
    code: RubricStoreErrorCode,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? code, options);
    this.name = "RubricStoreError";
    this.code = code;
  }
}

/** 空 rubric (skip 経路 / interview 失敗時のフォールバック用). */
export function emptyRubricAxes(): DeckRubricAxes {
  return {
    audience: null,
    duration_min: null,
    purpose: null,
    success_criteria: null,
    tone: null,
    anti_patterns: [],
  };
}

/**
 * 内部 6 軸の日本語ラベル (A004 §「軸はユーザーには直接見せない」).
 *
 * 軸名 (audience 等) は **internal field name** であり UI / プロンプトに直接出さない.
 * このマップを SSOT として 1 箇所に固定し、UI (mainview) と生成 prompt
 * (generate-prompt.ts) の両方からこの定数を参照する.
 */
export const AXIS_LABELS_JA: Record<string, string> = {
  audience: "聴衆",
  duration_min: "持ち時間 (分)",
  purpose: "目的",
  success_criteria: "成功条件",
  tone: "トーン / ブランド",
  anti_patterns: "避けたい型",
};
