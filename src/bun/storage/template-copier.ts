import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProjectStoreError } from "./types";

interface CopyEntry {
  src: string;
  dst: string;
}

/**
 * src は templateRoot 起点の相対パス、dst は cwd 起点の相対パス。
 * 「reveal.js bundle は slides/ 配下に展開、opencode.json/AGENTS.md は cwd 直下」というレイアウトを明示列挙。
 */
const REVEAL_TEMPLATE_FILES: readonly CopyEntry[] = [
  { src: "index.html", dst: "slides/index.html" },
  { src: "dist/reveal.css", dst: "slides/dist/reveal.css" },
  { src: "dist/reveal.js", dst: "slides/dist/reveal.js" },
  { src: "dist/theme/black.css", dst: "slides/dist/theme/black.css" },
  { src: "opencode.json", dst: "opencode.json" },
  { src: "AGENTS.md", dst: "AGENTS.md" },
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

  for (const entry of REVEAL_TEMPLATE_FILES) {
    const absSrc = join(srcRoot, entry.src);
    if (!(await exists(absSrc))) {
      throw new ProjectStoreError(
        "TEMPLATE_MISSING",
        `required template file missing: ${entry.src}`,
      );
    }
  }

  for (const entry of REVEAL_TEMPLATE_FILES) {
    const absSrc = join(srcRoot, entry.src);
    const absDst = join(dstCwd, entry.dst);
    await mkdir(dirname(absDst), { recursive: true });
    await copyFile(absSrc, absDst);
  }
}
