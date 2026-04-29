/**
 * exportHtmlZip — `slides/` 一式 + reveal.js dist + README を `<title>/` 階層に
 * 集めて `/usr/bin/zip` で 1 つのアーカイブに固める.
 *
 * 純粋関数 (`assembleStaging`, `verifyNoExternalRefs`, `sanitizeStagingDirName`) と
 * 副作用込みの `exportHtmlZip` (cycle 4) に分離する設計.
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
