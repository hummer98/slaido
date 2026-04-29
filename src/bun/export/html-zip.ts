/**
 * exportHtmlZip — `slides/` 一式 + reveal.js dist + README を `<title>/` 階層に
 * 集めて `/usr/bin/zip` で 1 つのアーカイブに固める.
 *
 * 純粋関数 (`assembleStaging`, `verifyNoExternalRefs`, `sanitizeStagingDirName`) と
 * 副作用込みの `exportHtmlZip` (cycle 4) に分離する設計.
 */

import { cp, mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ZipFailedError } from "./errors";

const ILLEGAL_DIR_CHARS = /[\/:]/g;

/** zip ルートディレクトリ名のサニタイズ. `/` `:` を `_` に置換し、潰れたら presentation. */
export function sanitizeStagingDirName(raw: string): string {
  const trimmed = raw.trim();
  const meaningful = trimmed.replace(ILLEGAL_DIR_CHARS, "");
  if (meaningful.trim().length === 0) return "presentation";
  return trimmed.replace(ILLEGAL_DIR_CHARS, "_");
}

const README_BODY = [
  "slAIdo HTML エクスポート",
  "",
  "index.html をダブルクリックするとブラウザでスライドが開きます。",
  "ネットワーク接続は不要です (オフライン再生対応).",
  "",
].join("\n");

export interface AssembleStagingArgs {
  /** 元 slides ディレクトリ (絶対 path). 配下を index.html を含めて全コピー */
  srcSlidesDir: string;
  /** reveal.js dist ディレクトリ (絶対 path). `<root>/dist/` にコピーする */
  distDir: string;
  /** ルート tmp dir (絶対 path). この直下に <title>/ を作る */
  stagingRoot: string;
  /** プロジェクト title. ルートディレクトリ名に使う */
  title: string;
}

export interface AssembleStagingResult {
  /** stagingRoot 配下のサニタイズ済みディレクトリ名 (絶対 path ではなく basename) */
  rootDirName: string;
}

/**
 * `<stagingRoot>/<title>/` を組み立て、index.html / dist / README を配置する.
 *
 *  1. `<stagingRoot>/<title>/` を mkdir
 *  2. srcSlidesDir 配下を `<root>/` にコピー (index.html / assets / etc.)
 *  3. distDir を `<root>/dist/` にコピー
 *  4. README.txt を書き出す
 *  5. `.DS_Store` / `__MACOSX` を再帰的に削除 (Critical C3 二重防御)
 */
export async function assembleStaging(
  args: AssembleStagingArgs,
): Promise<AssembleStagingResult> {
  const rootDirName = sanitizeStagingDirName(args.title);
  const root = join(args.stagingRoot, rootDirName);
  await mkdir(root, { recursive: true });

  // node:fs/promises の cp は recursive copy + symlink 保持 (macOS cp -R 相当).
  await cp(args.srcSlidesDir, root, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });

  const dest = join(root, "dist");
  await cp(args.distDir, dest, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });

  await writeFile(join(root, "README.txt"), README_BODY, "utf8");

  await scrubMacOsArtifacts(root);

  return { rootDirName };
}

/** `.DS_Store` / `__MACOSX` を再帰的に root 配下から削除. */
async function scrubMacOsArtifacts(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const child = join(root, ent.name);
    if (ent.name === ".DS_Store" || ent.name === "__MACOSX") {
      await rm(child, { recursive: true, force: true });
      continue;
    }
    if (ent.isDirectory()) {
      await scrubMacOsArtifacts(child);
    }
  }
}

export interface ExportHtmlZipArgs {
  /** プロジェクトの slides ディレクトリ (絶対 path) */
  slidesDir: string;
  /** reveal.js dist ディレクトリ (絶対 path) */
  distDir: string;
  /** 出力 zip ファイル (絶対 path). 既存ファイルがあれば上書き */
  outputPath: string;
  /** プロジェクト title. zip ルートディレクトリ名に使う */
  title: string;
  /** ユーザーキャンセル (将来拡張. 現状は spawn 中の kill 用フック) */
  signal?: AbortSignal;
}

export interface ExportHtmlZipDeps {
  /** spawn 注入. `string[]` cmd + cwd を受け取り、終了コードを返す */
  spawnZip?: (args: string[], cwd: string) => Promise<{ exitCode: number; stderr: string }>;
}

const ZIP_BIN = "/usr/bin/zip";

async function defaultSpawnZip(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([ZIP_BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  // stdout は読み捨てる (zip はファイルリストを stdout に出すが今回は不要)
  await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

/**
 * exportHtmlZip — slides + dist + README を `<title>/` 階層に集約して zip 化.
 *
 * 失敗時もテンポラリは finally で削除し、出力 path は best-effort で unlink.
 */
export async function exportHtmlZip(
  args: ExportHtmlZipArgs,
  deps: ExportHtmlZipDeps = {},
): Promise<void> {
  const spawnZip = deps.spawnZip ?? defaultSpawnZip;

  // 既存出力ファイルを削除 (zip のデフォルトは update なので / Minor m2)
  await unlink(args.outputPath).catch(() => {});

  const stagingRoot = await mkdtemp(join(tmpdir(), "slaido-export-"));
  try {
    const { rootDirName } = await assembleStaging({
      srcSlidesDir: args.slidesDir,
      distDir: args.distDir,
      stagingRoot,
      title: args.title,
    });

    // verifyNoExternalRefs は warning ログを残すだけで失敗扱いにしない
    try {
      const indexPath = join(stagingRoot, rootDirName, "index.html");
      const v = await verifyNoExternalRefs(indexPath);
      if (!v.ok) {
        console.warn(
          `[slAIdo] export-html-zip external-refs detected ${JSON.stringify({
            count: v.externalRefs.length,
            samples: v.externalRefs.slice(0, 3),
          })}`,
        );
      }
    } catch (err) {
      console.warn("[slAIdo] export-html-zip verifyNoExternalRefs failed:", err);
    }

    const { exitCode, stderr } = await spawnZip(
      [
        "-r",
        "-X",
        "--exclude=*/.DS_Store",
        "--exclude=__MACOSX/*",
        args.outputPath,
        rootDirName,
      ],
      stagingRoot,
    );

    if (exitCode !== 0) {
      await unlink(args.outputPath).catch(() => {});
      throw new ZipFailedError(
        `zip failed (exit=${exitCode}): ${stderr.trim() || "(no stderr)"}`,
        exitCode,
      );
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export interface VerifyNoExternalRefsResult {
  /** 外部参照が 0 件なら true */
  ok: boolean;
  /** 検出された外部参照の URL 一覧 (informational; 失敗扱いにはしない) */
  externalRefs: string[];
}

/**
 * HTML 内の <link href> / <script src> / <img src> 等が `https?://` または
 * protocol-relative `//` で始まっていないかを軽く scan する.
 *
 * 仕様: ユーザーが意図して入れている可能性もあるため失敗扱いにはしない.
 *      呼び出し側は warning ログだけ出して続行する想定.
 */
export async function verifyNoExternalRefs(
  htmlPath: string,
): Promise<VerifyNoExternalRefsResult> {
  await stat(htmlPath); // existence check (throws if missing)
  const html = await Bun.file(htmlPath).text();
  // src=, href= の値を `"..."` または `'...'` の中身で抜き出す簡易 scan
  const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  const externalRefs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const ref = m[1];
    if (!ref) continue;
    if (/^https?:\/\//i.test(ref) || ref.startsWith("//")) {
      externalRefs.push(ref);
    }
  }
  return { ok: externalRefs.length === 0, externalRefs };
}
