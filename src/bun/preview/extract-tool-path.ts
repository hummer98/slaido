/**
 * SSE 経由の `tool-status` event から編集対象パスを抽出する純粋関数.
 *
 * opencode SDK の `OpencodeToolState.input` は `{[key:string]: unknown}` で
 * キー名が固定されないため複数候補を順試行する.
 *
 * キー優先順位 (design-review Finding 3):
 *   filePath > file_path > file > path
 *
 * `path` は bash 系 tool でも別意味で使われ得るため最後尾にする.
 */

import type { OpencodeToolState } from "../opencode/types";

export const TOOL_PATH_KEYS = ["filePath", "file_path", "file", "path"] as const;

export function extractToolPath(state: OpencodeToolState): string | null {
  const input = (state as { input?: Record<string, unknown> }).input;
  if (!input || typeof input !== "object") return null;
  for (const key of TOOL_PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
