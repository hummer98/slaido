/**
 * slaido のロギング基盤。
 *
 * `docs/logging-policy.md` の規約に従い、`log` / `warn` / `error` の 3 API で
 * `~/Library/Logs/slAIdo/main.log` に追記する。`console.*` の直接呼び出しは原則禁止。
 *
 * ~/git/cmux-team/skills/cmux-team/manager/logger.ts を移植したもの。
 * cmux-team 固有の formatSurface / formatPair は外し、出力先を slaido 用に変更している。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_NAME = "slAIdo";

/** ローカル TZ オフセット付き ISO 8601 タイムスタンプ。 */
function localISOString(): string {
  const now = new Date();
  const off = now.getTimezoneOffset();
  const sign = off <= 0 ? "+" : "-";
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, "0");
  const mm = String(absOff % 60).padStart(2, "0");
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${hh}:${mm}`;
}

type LogLevel = "info" | "warn" | "error";

/**
 * 出力先ディレクトリ。テスト用に SLAIDO_LOG_DIR で上書きできる。
 * デフォルトは macOS 慣例の ~/Library/Logs/slAIdo/。
 */
function resolveLogDir(): string {
  const override = process.env.SLAIDO_LOG_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), "Library", "Logs", APP_NAME);
}

/** dev / test 判定。console mirror を有効にする条件。 */
function isDev(): boolean {
  // bun test 実行中は NODE_ENV=test が立つので mirror を有効化（spy 互換）。
  if (process.env.NODE_ENV === "test") return true;
  const channel = process.env.ELECTROBUN_CHANNEL;
  if (channel) return channel === "dev";
  // フォールバック: dev ビルドはアプリ ID に -dev サフィックスが付く
  return process.env.npm_lifecycle_event === "start";
}

async function appendLine(level: LogLevel, event: string, detail: string): Promise<void> {
  const logDir = resolveLogDir();
  const logFile = join(logDir, "main.log");
  const timestamp = localISOString();
  const levelPrefix = level === "info" ? "" : `[${level}] `;
  const line = `[${timestamp}] ${levelPrefix}${event} ${detail}`.trimEnd() + "\n";

  // dev ビルドのみ console にミラー（Electrobun launcher / IDE が捕捉できる経路）。
  // テストが console.log/warn/error を spy する慣行に合わせるため process.stdout.write
  // ではなく console.* 経由で出す。logger 自身が console.* を呼ぶこの 1 箇所のみ
  // policy の「console 直接呼び出し禁止」の例外。
  if (isDev()) {
    const text = line.replace(/\n$/, "");
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  }

  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(logFile, line);
  } catch (err) {
    // ファイル書き込み失敗は最後の手段として stderr に直接出す。
    // ここで再帰させるとループするので console.error を使う唯一の場所。
    process.stderr.write(
      `[${timestamp}] [error] logger_append_failed err=${(err as Error).message}\n`,
    );
  }
}

/** 通常イベント・状態遷移・ライフサイクル進捗 */
export async function log(event: string, detail: string = ""): Promise<void> {
  return appendLine("info", event, detail);
}

/** 想定内の異常・best-effort 失敗・リトライ前の劣化 */
export async function warn(event: string, detail: string = ""): Promise<void> {
  return appendLine("warn", event, detail);
}

/** 例外捕捉・操作失敗・データ整合性逸脱 */
export async function error(event: string, detail: string = ""): Promise<void> {
  return appendLine("error", event, detail);
}

/**
 * Error から detail 文字列を組み立てる。
 * `err="message"` の単一フィールド形にし、必要なら呼び出し側で他フィールドを連結する。
 */
export function fmtErr(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return `err=${JSON.stringify(e.message)}`;
}

/** API キー等の機密値を安全にログ出力するためのマスク（先頭 4-10 文字 + 長さ）。 */
export function mask(value: string, prefixLen: number = 6): string {
  if (!value) return "<empty>";
  const head = value.slice(0, Math.min(prefixLen, value.length));
  return `${head}…(len=${value.length})`;
}
