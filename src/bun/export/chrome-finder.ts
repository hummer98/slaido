/**
 * findChromium — system にインストールされた Chromium 系ブラウザを検出する.
 *
 * 優先順位 (Critical C1 / plan §1.3):
 *   1. env `SLAIDO_CHROME_PATH` が指す実行ファイル (テストで偽 executable を差し込めるよう最優先)
 *   2. `candidatePaths` (省略時は DEFAULT_CANDIDATES)
 *   3. なし → null
 */

const ENV_OVERRIDE_KEY = "SLAIDO_CHROME_PATH";

export const DEFAULT_CANDIDATES: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export interface FindChromiumDeps {
  /** 既定の `/Applications/...` 候補配列を差し替える (テスト用) */
  candidatePaths?: readonly string[];
}

export async function findChromium(
  deps: FindChromiumDeps = {},
): Promise<string | null> {
  const override = process.env[ENV_OVERRIDE_KEY];
  if (override && (await Bun.file(override).exists())) {
    return override;
  }

  const candidates = deps.candidatePaths ?? DEFAULT_CANDIDATES;
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}
