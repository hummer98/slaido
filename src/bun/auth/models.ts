/**
 * 検証用モデル ID 定数 (T010 / plan F8)
 *
 * 出典: T014 で確定した assets/templates/reveal/opencode.json の `small_model`
 * (`openrouter/anthropic/claude-haiku-4.5`)
 *
 * 変更時は本ファイルを更新するだけで key-validator にも反映される。
 */
export const VALIDATION_MODEL = {
  providerID: "openrouter",
  modelID: "anthropic/claude-haiku-4.5",
} as const;
