/**
 * showSaveDialog — macOS の NSSavePanel を osascript 経由で呼び出す.
 *
 * Electrobun には saveFileDialog API が無いため (plan §1.1 / §4.3),
 * AppleScript の `choose file name` を `Bun.spawn` で呼ぶ. ユーザーキャンセル時は
 * exit code 1 + stderr `(-128)` で判定し null を返す.
 */

import { homedir } from "node:os";

export interface ShowSaveDialogOptions {
  /** ダイアログのプロンプト文 */
  prompt?: string;
  /** 初期ファイル名. 拡張子も含む (例: "foo.pdf") */
  defaultName: string;
  /** 初期ディレクトリ. 省略時は `~/Documents` */
  defaultDir?: string;
  /** 強制する拡張子 ("pdf" / "zip" 等). 戻り値 path に必ずこれが付く */
  filterExt: string;
}

export interface ShowSaveDialogDeps {
  /**
   * osascript を spawn する代わりにテストから注入する関数.
   * stdout / stderr / exitCode を返すだけのシンプルな契約.
   */
  runOsascript?: (source: string) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

/**
 * stdout / stderr / exitCode から「path or null」を判定する純粋関数.
 *  - exit 0 + stdout: path (改行 trim + NFC 正規化)
 *  - exit !=0 + "(-128)" を含む stderr: null (canceled)
 *  - その他: throw
 */
export function parseOsascriptResult(
  stdout: string,
  exitCode: number,
  stderr: string,
): string | null {
  if (exitCode === 0) {
    const trimmed = stdout.replace(/\r?\n+$/g, "").trimEnd();
    if (trimmed.length === 0) {
      throw new Error(`osascript returned empty stdout (exitCode=${exitCode})`);
    }
    return trimmed.normalize("NFC");
  }
  // exit code != 0
  if (stderr.includes("(-128)") || /User canceled/i.test(stderr)) {
    return null;
  }
  throw new Error(
    `osascript failed (exitCode=${exitCode}): ${stderr.trim() || "(no stderr)"}`,
  );
}

const ILLEGAL_NAME_CHARS = /[\/:]/g;

/**
 * AppleScript の default name に渡すタイトルから `/` `:` を `_` に置換し、
 * 空文字列 / 全部潰れた場合は "presentation" を fallback に使う.
 */
export function sanitizeDefaultName(raw: string): string {
  const trimmed = raw.trim();
  // 元の文字列が空 / 全部記号で潰れる場合は presentation
  const meaningful = trimmed.replace(ILLEGAL_NAME_CHARS, "");
  if (meaningful.trim().length === 0) return "presentation";
  return trimmed.replace(ILLEGAL_NAME_CHARS, "_");
}

/**
 * 出力 path に拡張子 `.<ext>` を強制する. 既に同拡張子 (大文字小文字無視) なら no-op.
 * 別拡張子の場合は append する (上書きしない / Minor m4 の方針より単純化).
 */
export function ensureExtension(path: string, ext: string): string {
  const lowerPath = path.toLowerCase();
  const lowerExt = `.${ext.toLowerCase()}`;
  if (lowerPath.endsWith(lowerExt)) return path;
  return `${path}.${ext}`;
}

/**
 * AppleScript の `choose file name` 呼び出しソースを組み立てる.
 * defaultName は double quote をエスケープする.
 */
export function buildOsascriptSource(args: {
  prompt: string;
  defaultName: string;
  defaultDir: string;
}): string {
  const escapedPrompt = args.prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedName = args.defaultName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedDir = args.defaultDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    `set theFile to choose file name with prompt "${escapedPrompt}" default name "${escapedName}" default location (POSIX file "${escapedDir}")`,
    `return POSIX path of theFile`,
  ].join("\n");
}

async function defaultRunOsascript(source: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["/usr/bin/osascript", "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * NSSavePanel を表示し、選択された絶対 path を返す. キャンセル時は null.
 *
 * @returns 拡張子強制後の絶対 path, または null (canceled)
 */
export async function showSaveDialog(
  options: ShowSaveDialogOptions,
  deps: ShowSaveDialogDeps = {},
): Promise<string | null> {
  const prompt = options.prompt ?? "保存先を選択";
  const defaultDir = options.defaultDir ?? `${homedir()}/Documents`;
  const sanitizedName = sanitizeDefaultName(options.defaultName);
  const finalName = ensureExtension(sanitizedName, options.filterExt);

  const source = buildOsascriptSource({
    prompt,
    defaultName: finalName,
    defaultDir,
  });

  const runOsascript = deps.runOsascript ?? defaultRunOsascript;
  const { stdout, stderr, exitCode } = await runOsascript(source);
  const path = parseOsascriptResult(stdout, exitCode, stderr);
  if (path === null) return null;
  return ensureExtension(path, options.filterExt);
}
