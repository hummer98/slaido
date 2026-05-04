import { describe, expect, test } from "bun:test";

import { buildGeneratePrompt } from "./generate-prompt";
import type { DeckRubric } from "./storage/rubric-types";

const SLIDES_ENTRY = "/tmp/p1/slides/index.html";
const SEED = "シード本文";

function buildRubric(overrides: Partial<DeckRubric["axes"]> = {}): DeckRubric {
  return {
    schemaVersion: 1,
    axes: {
      audience: null,
      duration_min: null,
      purpose: null,
      success_criteria: null,
      tone: null,
      anti_patterns: [],
      ...overrides,
    },
    raw_interview_log: [],
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  };
}

describe("buildGeneratePrompt", () => {
  test("rubric 未指定: 「## このスライドの前提条件」を含まない", () => {
    const out = buildGeneratePrompt(SLIDES_ENTRY, SEED);
    expect(out).not.toContain("## このスライドの前提条件");
    expect(out).toContain(SEED);
    expect(out).toContain(SLIDES_ENTRY);
  });

  test("rubric=null: 既存挙動と完全一致 (前提条件セクション無し)", () => {
    const out = buildGeneratePrompt(SLIDES_ENTRY, SEED, null);
    expect(out).not.toContain("## このスライドの前提条件");
  });

  test("rubric ありで全 null 軸: 前提条件セクションを出さない", () => {
    const out = buildGeneratePrompt(SLIDES_ENTRY, SEED, buildRubric());
    expect(out).not.toContain("## このスライドの前提条件");
  });

  test("rubric: 前提条件セクションが seed の前に挿入される", () => {
    const out = buildGeneratePrompt(
      SLIDES_ENTRY,
      SEED,
      buildRubric({ audience: "社内エンジニア" }),
    );
    expect(out).toContain("## このスライドの前提条件");
    const sectionIdx = out.indexOf("## このスライドの前提条件");
    const seedIdx = out.indexOf(SEED);
    expect(sectionIdx).toBeGreaterThan(0);
    expect(seedIdx).toBeGreaterThan(sectionIdx);
  });

  test("rubric: null 軸は出力に含まれない / 埋まった軸は日本語ラベルで出る", () => {
    const out = buildGeneratePrompt(
      SLIDES_ENTRY,
      SEED,
      buildRubric({
        audience: "社内エンジニア",
        purpose: "教育",
        // duration_min, success_criteria, tone は null
      }),
    );
    expect(out).toContain("聴衆: 社内エンジニア");
    expect(out).toContain("目的: 教育");
    expect(out).not.toContain("持ち時間");
    expect(out).not.toContain("成功条件");
    expect(out).not.toContain("トーン");
    // 内部 field name は出さない
    expect(out).not.toContain("audience:");
    expect(out).not.toContain("purpose:");
  });

  test("anti_patterns 空配列は省略", () => {
    const out = buildGeneratePrompt(
      SLIDES_ENTRY,
      SEED,
      buildRubric({ audience: "x", anti_patterns: [] }),
    );
    expect(out).not.toContain("避けたい型");
  });

  test("anti_patterns 1 件以上は ' / ' で連結して出力", () => {
    const out = buildGeneratePrompt(
      SLIDES_ENTRY,
      SEED,
      buildRubric({ audience: "x", anti_patterns: ["Gamma 風", "ピンク多用"] }),
    );
    expect(out).toContain("避けたい型: Gamma 風 / ピンク多用");
  });

  test("Write tool の指示と slidesEntry の絶対パスは保持される (既存の生成挙動)", () => {
    const out = buildGeneratePrompt(SLIDES_ENTRY, SEED);
    expect(out).toContain("Write ツール");
    expect(out).toContain(SLIDES_ENTRY);
    expect(out).toContain("dist/reveal.css");
  });
});
