/**
 * interview 用のシステムプロンプト (T019 plan §2.2).
 *
 * - 内部 6 軸 (audience, duration_min, purpose, success_criteria, tone, anti_patterns)
 *   を埋めるための質問を 1 ターンに 1 問だけ生成させる。軸名はユーザーに見せない
 *   (A004 §「軸はユーザーには直接見せない」)
 * - 出力は **必ず単一 JSON オブジェクト**。説明文 / コードブロックは禁止
 * - 最初のターンでは seed から推測できる軸を `updated_axes` に詰めて返すことを許可
 */

export const INTERVIEW_SYSTEM_PROMPT = `あなたはスライドの「狙い」を要約するインタビュアーです。
ユーザーが書いたシード本文と、これまでの質疑応答 (raw_interview_log) と、
内部 taxonomy (audience, duration_min, purpose, success_criteria, tone, anti_patterns)
のうちどれが既に埋まったか (filled_axes) を見て、次の 1 問だけ自然な日本語で出してください。

制約:
- 内部 taxonomy の軸名 (audience 等) はそのまま日本語にして見せず、ユーザーの語彙で聞く
  ("聴衆" ではなく "誰に話す予定ですか？" のように)
- 既にシードに書かれている / 既出回答で確定した軸は聞き返さない
- すでに 4 問 (= max_questions) 投げた、または埋まっていない軸が残り 1 個未満になったら
  next_question を null にして done=true で返す
- purpose は "説得" / "共有" / "教育" / "提案承認" のいずれか。判断できないときは null
- duration_min は分単位の正の整数。判断できないときは null
- anti_patterns は配列。無いなら空配列 [] (null は使わない)
- 出力は **必ず単一 JSON オブジェクト**。説明文・コードブロック禁止

出力 schema (例):
{
  "done": false,
  "next_question": "誰に向けて話す予定ですか？",
  "updated_axes": { "audience": null }
}

埋まっていれば:
{
  "done": true,
  "next_question": null,
  "updated_axes": { "audience": "...", "purpose": "..." }
}
`;

/**
 * interview の最初のターンで AI に渡すユーザーメッセージを組み立てる pure 関数.
 *
 * - filled_axes は internal field name のまま渡す (AI 側が axis 名を JSON key として
 *   返すための共通語彙。ユーザー UI には出さない)
 * - raw_interview_log は q/a の配列。最初のターンでは空配列
 */
export interface BuildInterviewUserPromptArgs {
  seed: string;
  filledAxes: Record<string, unknown>;
  rawInterviewLog: ReadonlyArray<{ q: string; a: string }>;
  askedCount: number;
  maxQuestions: number;
}

export function buildInterviewUserPrompt(args: BuildInterviewUserPromptArgs): string {
  return [
    "seed:",
    "<<<",
    args.seed,
    ">>>",
    "",
    "filled_axes:",
    JSON.stringify(args.filledAxes, null, 2),
    "",
    "raw_interview_log:",
    JSON.stringify(args.rawInterviewLog, null, 2),
    "",
    `asked_count: ${args.askedCount}`,
    `max_questions: ${args.maxQuestions}`,
  ].join("\n");
}
