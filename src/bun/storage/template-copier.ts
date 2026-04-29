import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProjectStoreError } from "./types";

interface CopyEntry {
  src: string;
  dst: string;
}

/** create() が失敗してはいけない最小ファイル群（src は templateRoot 起点 / dst は cwd 起点）。 */
const REQUIRED_FILES: readonly CopyEntry[] = [
  { src: "index.html", dst: "slides/index.html" },
  { src: "dist/reveal.css", dst: "slides/dist/reveal.css" },
  { src: "dist/reveal.js", dst: "slides/dist/reveal.js" },
  { src: "dist/theme/black.css", dst: "slides/dist/theme/black.css" },
  { src: "opencode.json", dst: "opencode.json" },
  { src: "AGENTS.md", dst: "AGENTS.md" },
];

/** 存在すれば一緒にコピーする補助ファイル（reset.css とテーマフォント等）。 */
const OPTIONAL_FILES: readonly CopyEntry[] = [
  { src: "dist/reset.css", dst: "slides/dist/reset.css" },
  ...[
    "source-sans-pro.css",
    "source-sans-pro-regular.eot",
    "source-sans-pro-regular.ttf",
    "source-sans-pro-regular.woff",
    "source-sans-pro-italic.eot",
    "source-sans-pro-italic.ttf",
    "source-sans-pro-italic.woff",
    "source-sans-pro-semibold.eot",
    "source-sans-pro-semibold.ttf",
    "source-sans-pro-semibold.woff",
    "source-sans-pro-semibolditalic.eot",
    "source-sans-pro-semibolditalic.ttf",
    "source-sans-pro-semibolditalic.woff",
  ].map((file) => ({
    src: `dist/theme/fonts/source-sans-pro/${file}`,
    dst: `slides/dist/theme/fonts/source-sans-pro/${file}`,
  })),
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function copyRevealTemplate(srcRoot: string, dstCwd: string): Promise<void> {
  if (!(await exists(srcRoot))) {
    throw new ProjectStoreError("TEMPLATE_MISSING", `template root not found: ${srcRoot}`);
  }

  for (const entry of REQUIRED_FILES) {
    if (!(await exists(join(srcRoot, entry.src)))) {
      throw new ProjectStoreError(
        "TEMPLATE_MISSING",
        `required template file missing: ${entry.src}`,
      );
    }
  }

  for (const entry of REQUIRED_FILES) {
    await copyOne(srcRoot, dstCwd, entry);
  }
  for (const entry of OPTIONAL_FILES) {
    if (await exists(join(srcRoot, entry.src))) {
      await copyOne(srcRoot, dstCwd, entry);
    }
  }
}

async function copyOne(srcRoot: string, dstCwd: string, entry: CopyEntry): Promise<void> {
  const absSrc = join(srcRoot, entry.src);
  const absDst = join(dstCwd, entry.dst);
  await mkdir(dirname(absDst), { recursive: true });
  await copyFile(absSrc, absDst);
}
