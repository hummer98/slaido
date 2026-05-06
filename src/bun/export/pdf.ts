/**
 * exportPdf — 外部 Chromium 系ブラウザを headless で spawn し、reveal.js の
 * `?print-pdf` モードで PDF を生成する.
 *
 * 設計判断は plan §1.2 / §1.5. テストは PdfDeps.spawn 関数注入を base にし
 * (Major M1)、env 経由 (`SLAIDO_CHROME_PATH`) の wrapper script は add-on テスト.
 *
 * T021: Chrome 147 headless の `--print-to-pdf` 完了後 exit hang 対策として
 *  - PDF 出力を polling 検知 → 500ms grace → SIGTERM (3s 後に SIGKILL escalate)
 *  - 絶対 timeout (既定 60s) で SIGKILL → PdfPrintError throw
 * を `defaultSpawn` に組み込む. plan §3.1〜§3.5 参照.
 */

import { existsSync, statSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { findChromium as defaultFindChromium } from "./chrome-finder";
import { ChromiumNotFoundError, PdfPrintError } from "./errors";

const DEFAULT_KILL_AFTER_MS = 60_000;
const POLL_INTERVAL_MS = 200;
const FLUSH_GRACE_MS = 500;
const SIGTERM_ESCALATE_MS = 3_000;
const SIGTERM = 15;
const SIGKILL = 9;

export interface PdfExportArgs {
  /** 絶対 path. 必ず pathToFileURL(...).href + "?print-pdf" で URL 化 (Major M5) */
  slidesEntry: string;
  /** 絶対 path. ユーザーが NSSavePanel で選んだファイル */
  outputPath: string;
  /** findChromium() の結果. 省略時は deps.findChromium / chrome-finder を呼ぶ */
  chromiumPath?: string;
  /** 必須 (Critical C2). mkdtemp で都度作成し finally で削除する責任は呼び出し側 */
  userDataDir: string;
  /** spawn timeout (ms). 既定 60000 (T021: Chrome exit hang を SIGKILL する閾値) */
  timeoutMs?: number;
  /** ユーザーキャンセル用 */
  signal?: AbortSignal;
}

export interface PdfDeps {
  /** spawn 注入. テストから差し替えて実 Chrome を起動しないようにする */
  spawn?: (
    cmd: string[],
    opts: {
      signal?: AbortSignal;
      /** PDF 書き込み完了 polling 用. 未指定なら polling しない */
      outputPath?: string;
      /** 絶対 timeout (ms). 未指定なら timeout なし */
      killAfterMs?: number;
    },
  ) => Promise<{ exitCode: number; stderr: string; killedByUs?: boolean }>;
  /** findChromium 注入 */
  findChromium?: () => Promise<string | null>;
}

/**
 * Chromium に渡す引数を組み立てる純粋関数. テストで args の構造を assert する.
 *
 * 引数順は意味ある順序ではないが、`--user-data-dir` / `--print-to-pdf` /
 * URL の存在は test で固定する.
 */
export function buildChromiumArgs(
  slidesEntry: string,
  outputPath: string,
  userDataDir: string,
): string[] {
  const url = `${pathToFileURL(slidesEntry).href}?print-pdf`;
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-pdf-header-footer",
    "--virtual-time-budget=10000",
    "--allow-file-access-from-files",
    `--user-data-dir=${userDataDir}`,
    `--print-to-pdf=${outputPath}`,
    url,
  ];
}

/**
 * `Bun.spawn` 互換の最小 shape. テスト用の mock 注入を許容するため
 * `_makeDefaultSpawn` の引数を typeof Bun.spawn にせず、必要 field だけを参照する.
 */
type SpawnedProc = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal?: number) => void;
};
type SpawnImpl = (
  cmd: string[],
  opts: { stdout: "pipe"; stderr: "pipe"; signal?: AbortSignal },
) => SpawnedProc;

/**
 * `defaultSpawn` を生成するファクトリ. 内部の `Bun.spawn` を test から差し替えるための
 * 2 層構成 (plan §6 フォールバック). 通常は引数なしで使う.
 *
 * underscore prefix は test 専用 export であることを示す.
 */
export function _makeDefaultSpawn(
  spawnImpl: SpawnImpl = Bun.spawn as unknown as SpawnImpl,
): NonNullable<PdfDeps["spawn"]> {
  return async (cmd, opts) => {
    const proc = spawnImpl(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    let killedByUs = false;
    let timedOut = false;
    let pollHandle: ReturnType<typeof setInterval> | null = null;
    let graceHandle: ReturnType<typeof setTimeout> | null = null;
    let escalateHandle: ReturnType<typeof setTimeout> | null = null;
    let killAfterHandle: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      if (graceHandle) {
        clearTimeout(graceHandle);
        graceHandle = null;
      }
      if (escalateHandle) {
        clearTimeout(escalateHandle);
        escalateHandle = null;
      }
      if (killAfterHandle) {
        clearTimeout(killAfterHandle);
        killAfterHandle = null;
      }
    };

    if (opts.outputPath) {
      const outPath = opts.outputPath;
      pollHandle = setInterval(() => {
        try {
          if (existsSync(outPath) && statSync(outPath).size > 0) {
            if (pollHandle) {
              clearInterval(pollHandle);
              pollHandle = null;
            }
            // flush 中に kill すると半端 PDF になりうるので 500ms grace
            graceHandle = setTimeout(() => {
              graceHandle = null;
              killedByUs = true;
              try {
                proc.kill(SIGTERM);
              } catch {}
              // SIGTERM を ignore された場合の保険
              escalateHandle = setTimeout(() => {
                escalateHandle = null;
                try {
                  proc.kill(SIGKILL);
                } catch {}
              }, SIGTERM_ESCALATE_MS);
            }, FLUSH_GRACE_MS);
          }
        } catch {
          // statSync が失敗 (race 等) しても polling 続行
        }
      }, POLL_INTERVAL_MS);
    }

    if (opts.killAfterMs && opts.killAfterMs > 0) {
      killAfterHandle = setTimeout(() => {
        killAfterHandle = null;
        timedOut = true;
        if (pollHandle) {
          clearInterval(pollHandle);
          pollHandle = null;
        }
        if (graceHandle) {
          clearTimeout(graceHandle);
          graceHandle = null;
        }
        try {
          proc.kill(SIGKILL);
        } catch {}
      }, opts.killAfterMs);
    }

    let stderr = "";
    try {
      if (proc.stderr) stderr = await new Response(proc.stderr).text();
      if (proc.stdout) await new Response(proc.stdout).text(); // 読み捨て
    } catch {
      // SIGKILL でストリームが破棄されることがある — 無視して exit code を待つ
    }
    const exitCode = await proc.exited;
    clearTimers();

    if (timedOut) {
      throw new PdfPrintError(
        `Chromium did not exit within ${opts.killAfterMs}ms (timeout, force-killed)`,
        -1,
      );
    }

    return { exitCode, stderr, killedByUs };
  };
}

const defaultSpawn = _makeDefaultSpawn();

/**
 * Chromium を spawn して PDF を作る. 終了コード非ゼロ / 出力 0 byte で失敗扱い.
 *
 * T021: `defaultSpawn` 側で PDF 完了検知 → kill / 絶対 timeout → SIGKILL を行うため
 * `killedByUs === true` のときは exit code 非ゼロでもエラーにしない (kill 由来の
 * SIGTERM/SIGKILL は exit code 143/137 で返るため).
 */
export async function exportPdf(
  args: PdfExportArgs,
  deps: PdfDeps = {},
): Promise<void> {
  const spawn = deps.spawn ?? defaultSpawn;
  const findFn = deps.findChromium ?? defaultFindChromium;

  let chromiumPath = args.chromiumPath;
  if (!chromiumPath) {
    const found = await findFn();
    if (!found) throw new ChromiumNotFoundError();
    chromiumPath = found;
  }

  // 出力 path に古いファイルがあれば削除しておく (空ファイル判定が誤発火しないように)
  await unlink(args.outputPath).catch(() => {});

  const cmdArgs = buildChromiumArgs(args.slidesEntry, args.outputPath, args.userDataDir);
  const cmd = [chromiumPath, ...cmdArgs];

  let exitCode: number;
  let stderr: string;
  let killedByUs: boolean;
  try {
    const result = await spawn(cmd, {
      ...(args.signal ? { signal: args.signal } : {}),
      outputPath: args.outputPath,
      killAfterMs: args.timeoutMs ?? DEFAULT_KILL_AFTER_MS,
    });
    exitCode = result.exitCode;
    stderr = result.stderr;
    killedByUs = result.killedByUs === true;
  } catch (err) {
    await unlink(args.outputPath).catch(() => {});
    if (err instanceof PdfPrintError) throw err;
    throw new PdfPrintError(
      `Chromium spawn failed: ${(err as Error).message}`,
      -1,
    );
  }

  // kill 由来 (killedByUs) の非ゼロ exit code は許容. 自然 exit の非ゼロのみエラー扱い.
  if (!killedByUs && exitCode !== 0) {
    await unlink(args.outputPath).catch(() => {});
    throw new PdfPrintError(
      `Chromium exited non-zero (exit=${exitCode}): ${stderr.trim() || "(no stderr)"}`,
      exitCode,
    );
  }

  // 出力ファイルが存在し、0 byte でないこと
  let s;
  try {
    s = await stat(args.outputPath);
  } catch {
    throw new PdfPrintError("Chromium did not produce output file", exitCode);
  }
  if (s.size === 0) {
    await unlink(args.outputPath).catch(() => {});
    throw new PdfPrintError("Chromium produced an empty PDF (0 byte)", exitCode);
  }
}
