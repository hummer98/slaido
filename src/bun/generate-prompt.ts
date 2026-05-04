/**
 * 生成 prompt 組み立て (T019 plan §S9a).
 *
 * `src/bun/index.ts` のインライン版から切り出して独立ファイル化した。
 * rubric が渡された場合は `## このスライドの前提条件` セクションを seed の **前** に
 * 挿入する (本タスクの最小注入: A003 ループ本体は別タスク)。
 *
 * - rubric が `null` / `undefined`: 既存挙動と完全一致 (前提条件セクション無し)
 * - axes の null 軸は出力に含めない
 * - `anti_patterns: []` は省略 (空表記は出さない)
 */

import { AXIS_LABELS_JA, type DeckRubric } from "./storage/rubric-types";

export function buildGeneratePrompt(
  slidesEntry: string,
  seedContent: string,
  rubric?: DeckRubric | null,
): string {
  const lines = [
    "シードドキュメントから reveal.js スライドを生成してください。",
    "",
    `**Write ツールで以下の絶対パスにファイル全体を書き込んでください**: ${slidesEntry}`,
    "",
    "テンプレート (この形を厳守。head/script の dist/ 参照は維持):",
    "```html",
    "<!DOCTYPE html>",
    '<html lang="ja">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    "  <title>...</title>",
    '  <link rel="stylesheet" href="dist/reset.css">',
    '  <link rel="stylesheet" href="dist/reveal.css">',
    '  <link rel="stylesheet" href="dist/theme/black.css">',
    "</head>",
    "<body>",
    '  <div class="reveal"><div class="slides">',
    "    <section>...</section>  <!-- タイトル + 本編 + まとめで 5 枚以上 -->",
    "  </div></div>",
    '  <script src="dist/reveal.js"></script>',
    "  <script>Reveal.initialize({hash:false});</script>",
    "</body></html>",
    "```",
    "",
    "**チャット欄での応答は完了報告のみ** (例: 「7 枚のスライドを生成しました」)。",
    "**HTML 本文をチャットに貼り付けないでください**。Write ツールの結果だけで十分です。",
    "",
  ];

  const rubricSection = rubric ? buildRubricSection(rubric) : null;
  if (rubricSection) {
    lines.push(rubricSection);
    lines.push("");
  }

  lines.push("シード:");
  lines.push(seedContent);
  return lines.join("\n");
}

function buildRubricSection(rubric: DeckRubric): string | null {
  const items: string[] = [];
  const a = rubric.axes;
  if (a.audience !== null) {
    items.push(`- ${AXIS_LABELS_JA["audience"]}: ${a.audience}`);
  }
  if (a.duration_min !== null) {
    items.push(`- ${AXIS_LABELS_JA["duration_min"]}: ${a.duration_min}`);
  }
  if (a.purpose !== null) {
    items.push(`- ${AXIS_LABELS_JA["purpose"]}: ${a.purpose}`);
  }
  if (a.success_criteria !== null) {
    items.push(`- ${AXIS_LABELS_JA["success_criteria"]}: ${a.success_criteria}`);
  }
  if (a.tone !== null) {
    items.push(`- ${AXIS_LABELS_JA["tone"]}: ${a.tone}`);
  }
  if (a.anti_patterns.length > 0) {
    items.push(
      `- ${AXIS_LABELS_JA["anti_patterns"]}: ${a.anti_patterns.join(" / ")}`,
    );
  }
  if (items.length === 0) return null;
  return ["## このスライドの前提条件", ...items].join("\n");
}
