import { describe, it, expect } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const REAL_TEMPLATE_ROOT = join(REPO_ROOT, "assets", "templates", "reveal");
const FIXTURE_TEMPLATE_ROOT = join(REPO_ROOT, "tests", "fixtures", "reveal-template");

const REAL_AGENTS = join(REAL_TEMPLATE_ROOT, "AGENTS.md");
const REAL_JSON = join(REAL_TEMPLATE_ROOT, "opencode.json");
const FIXTURE_AGENTS = join(FIXTURE_TEMPLATE_ROOT, "AGENTS.md");
const FIXTURE_JSON = join(FIXTURE_TEMPLATE_ROOT, "opencode.json");

const SMOKE_SEED = join(REPO_ROOT, "tests", "fixtures", "smoke", "seed.md");

interface OpencodeConfig {
  $schema: string;
  model: string;
  small_model: string;
  provider: {
    openrouter: {
      options: { apiKey: string };
      models: Record<string, unknown>;
    };
  };
  permission: {
    edit: string;
    bash: string;
    webfetch: string;
  };
}

function assertOpencodeJson(path: string): void {
  const text = readFileSync(path, "utf8");
  const cfg = JSON.parse(text) as OpencodeConfig;
  expect(cfg.$schema).toBe("https://opencode.ai/config.json");
  expect(cfg.model).toBe("openrouter/anthropic/claude-sonnet-4.5");
  expect(cfg.small_model).toBe("openrouter/anthropic/claude-haiku-4.5");
  expect(cfg.provider.openrouter.options.apiKey).toBe("{env:OPENROUTER_API_KEY}");
  expect(cfg.provider.openrouter.models["anthropic/claude-sonnet-4.5"]).toBeDefined();
  expect(cfg.provider.openrouter.models["anthropic/claude-haiku-4.5"]).toBeDefined();
  expect(cfg.permission.edit).toBe("allow");
  expect(cfg.permission.bash).toBe("ask");
  expect(cfg.permission.webfetch).toBe("deny");
}

describe("opencode.json template", () => {
  it("fixture の opencode.json が必須キーを満たす", () => {
    assertOpencodeJson(FIXTURE_JSON);
  });

  it("実テンプレ (assets/templates/reveal) の opencode.json が必須キーを満たす", () => {
    assertOpencodeJson(REAL_JSON);
  });
});

describe("AGENTS.md template", () => {
  it("必須見出しがすべて含まれ、出現順序が正しい", () => {
    const text = readFileSync(REAL_AGENTS, "utf8");
    const sections = [
      "# slAIdo",
      "## Mission",
      "## Output Contract",
      "### File Layout",
      "### Slide Unit Rule",
      "### Asset References",
      "## Seed Interpretation",
      "## Editing Rules",
      "## Don't",
      "## Examples",
    ];
    let lastIdx = -1;
    for (const h of sections) {
      const i = text.indexOf(h);
      expect(i).toBeGreaterThan(lastIdx);
      lastIdx = i;
    }
  });

  it("4096 byte 以下に収まっている", () => {
    const text = readFileSync(REAL_AGENTS, "utf8");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4096);
  });
});

describe("fixture と実テンプレの同一性", () => {
  it("fixture と実テンプレが同一バイト列", () => {
    expect(readFileSync(REAL_AGENTS, "utf8")).toBe(readFileSync(FIXTURE_AGENTS, "utf8"));
    expect(readFileSync(REAL_JSON, "utf8")).toBe(readFileSync(FIXTURE_JSON, "utf8"));
  });
});

describe("smoke seed fixture", () => {
  it("tests/fixtures/smoke/seed.md が存在し、空でない", () => {
    const stat = statSync(SMOKE_SEED);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });
});
