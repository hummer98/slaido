import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const APP_NAME = "slAIdo";

function resolveHome(homeOverride?: string): string {
  if (typeof homeOverride === "string" && homeOverride.length > 0) {
    return homeOverride;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home;
}

export function getAppDataRoot(homeOverride?: string): string {
  return join(
    resolveHome(homeOverride),
    "Library",
    "Application Support",
    APP_NAME,
  );
}

export function getProjectsRoot(homeOverride?: string): string {
  return join(getAppDataRoot(homeOverride), "projects");
}

export function getLastOpenedFile(homeOverride?: string): string {
  return join(getAppDataRoot(homeOverride), "last-opened.json");
}

/**
 * bundle 同梱の reveal.js テンプレ絶対パスを解決する。
 *
 * 1. import.meta.dir 起点に近い Resources ディレクトリを探索（Electrobun bundle / build:dev）
 * 2. 見つからなければ repo root の `assets/templates/reveal` にフォールバック（dev 起動時の保険）
 */
export function getBundledTemplateRoot(): string {
  const candidates: string[] = [];
  const here = import.meta.dir;

  candidates.push(resolve(here, "..", "..", "..", "Resources", "templates", "reveal"));
  candidates.push(resolve(here, "..", "..", "Resources", "templates", "reveal"));
  candidates.push(resolve(here, "..", "Resources", "templates", "reveal"));

  let cursor = here;
  for (let i = 0; i < 8; i += 1) {
    candidates.push(join(cursor, "assets", "templates", "reveal"));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1] ?? resolve(here, "..", "..", "..", "assets", "templates", "reveal");
}
