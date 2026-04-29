/**
 * exportPdf — 外部 Chromium 系ブラウザを headless で spawn し、reveal.js の
 * `?print-pdf` モードで PDF を生成する.
 *
 * 設計判断は plan §1.2 / §1.5. テストは PdfDeps.spawn 関数注入を base にし
 * (Major M1)、env 経由 (`SLAIDO_CHROME_PATH`) の wrapper script は add-on テスト.
 */

import { stat, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { findChromium as defaultFindChromium } from "./chrome-finder";
import { ChromiumNotFoundError, PdfPrintError } from "./errors";

export interface PdfExportArgs {
  /** 絶対 path. 必ず pathToFileURL(...).href + "?print-pdf" で URL 化 (Major M5) */
  slidesEntry: string;
  /** 絶対 path. ユーザーが NSSavePanel で選んだファイル */
  outputPath: string;
  /** findChromium() の結果. 省略時は deps.findChromium / chrome-finder を呼ぶ */
  chromiumPath?: string;
  /** 必須 (Critical C2). mkdtemp で都度作成し finally で削除する責任は呼び出し側 */
  userDataDir: string;
  /** spawn timeout (ms). 既定 60000 */
  timeoutMs?: number;
  /** ユーザーキャンセル用 */
  signal?: AbortSignal;
}

export interface PdfDeps {
  /** spawn 注入. テストから差し替えて実 Chrome を起動しないようにする */
  spawn?: (
    cmd: string[],
    opts: { signal?: AbortSignal },
  ) => Promise<{ exitCode: number; stderr: string }>;
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

async function defaultSpawn(
  cmd: string[],
  opts: { signal?: AbortSignal },
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const stderr = await new Response(proc.stderr).text();
  await new Response(proc.stdout).text(); // 読み捨て
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

/**
 * Chromium を spawn して PDF を作る. 終了コード非ゼロ / 出力 0 byte で失敗扱い.
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
  try {
    const result = await spawn(cmd, args.signal ? { signal: args.signal } : {});
    exitCode = result.exitCode;
    stderr = result.stderr;
  } catch (err) {
    await unlink(args.outputPath).catch(() => {});
    throw new PdfPrintError(
      `Chromium spawn failed: ${(err as Error).message}`,
      -1,
    );
  }

  if (exitCode !== 0) {
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
