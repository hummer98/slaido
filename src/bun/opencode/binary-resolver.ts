/**
 * opencode バイナリの実行時パス解決。
 *
 * 解決順序:
 *   1. override 引数 (テスト用)
 *   2. process.env.OPENCODE_BIN (開発時上書き)
 *   3. <baseDir>/bin/<arch>/opencode
 *      baseDir 未指定時は import.meta.dir の親 (バンドル後 = Resources/app/)
 *
 * NOTE: process.cwd() を使わない。electrobun の launcher は cwd を Contents/MacOS/
 * に設定するため、process.cwd() 起点では Resources/app/ に解決できない。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type SupportedArch = "darwin-arm64" | "darwin-x64";

export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}

export function detectArch(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): SupportedArch {
  if (platform !== "darwin") {
    throw new UnsupportedPlatformError(
      `Unsupported platform: ${platform}. MVP supports macOS only.`
    );
  }
  if (arch === "arm64") return "darwin-arm64";
  if (arch === "x64") return "darwin-x64";
  throw new UnsupportedPlatformError(`Unsupported arch: ${arch}`);
}

export interface ResolveOpencodeBinaryOptions {
  /** テスト・コンストラクタからの上書き. 最優先 */
  override?: string;
  /** 解決の base directory. 未指定なら resolve(import.meta.dir, "..") */
  baseDir?: string;
  /** 環境変数アクセサ. テストで差し替え可能 */
  env?: NodeJS.ProcessEnv;
}

export function resolveOpencodeBinary(
  options: ResolveOpencodeBinaryOptions = {}
): string {
  if (options.override) return options.override;
  const env = options.env ?? process.env;
  if (env.OPENCODE_BIN) return env.OPENCODE_BIN;

  const arch = detectArch();
  // バンドル後: import.meta.dir = Resources/app/bun/  → baseDir = Resources/app/
  // → Resources/app/bin/<arch>/opencode
  const baseDir = options.baseDir ?? resolve(import.meta.dir, "..");
  return resolve(baseDir, "bin", arch, "opencode");
}

export function assertBinaryExists(path: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `opencode binary not found at ${path}. Run \`bun run fetchOpencode\` first.`
    );
  }
}
