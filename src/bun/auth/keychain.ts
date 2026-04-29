/**
 * KeychainAdapter — macOS Keychain 経由の OpenRouter API キー保管.
 *
 * - macOS: `/usr/bin/security` CLI を `Bun.spawn` で呼ぶ
 *   - service: `dev.slaido.app`, account: `openrouter`
 *   - exit 0 = 成功, exit 44 = errSecItemNotFound
 * - macOS 以外:
 *   - getApiKey() は `process.env[envFallbackKey]` を返す (Linux/CI 開発用)
 *   - setApiKey() / deleteApiKey() は `KeychainUnsupportedError` を throw
 *
 * ログにキー値を残さないこと。値を扱う場合は `maskApiKey()` (key-validator.ts) を使う。
 */

const DEFAULT_SERVICE = "dev.slaido.app";
const DEFAULT_ACCOUNT = "openrouter";
const DEFAULT_SECURITY_BIN = "/usr/bin/security";
const DEFAULT_ENV_FALLBACK_KEY = "OPENROUTER_API_KEY";
const ITEM_NOT_FOUND_EXIT = 44;

export class KeychainUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainUnsupportedError";
  }
}

export class KeychainAccessError extends Error {
  constructor(message: string, public readonly exitCode?: number) {
    super(message);
    this.name = "KeychainAccessError";
  }
}

export interface KeychainAdapterOptions {
  /** Keychain service 名 (default: "dev.slaido.app") */
  service?: string;
  /** Keychain account 名 (default: "openrouter") */
  account?: string;
  /** `security` CLI のパス. テスト用に上書き可 (default: "/usr/bin/security") */
  securityBin?: string;
  /** macOS 以外で getApiKey() の env fallback として読むキー (default: "OPENROUTER_API_KEY") */
  envFallbackKey?: string;
  /** プラットフォーム override (テスト用). default: process.platform */
  platform?: NodeJS.Platform;
}

export class KeychainAdapter {
  private readonly service: string;
  private readonly account: string;
  private readonly securityBin: string;
  private readonly envFallbackKey: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: KeychainAdapterOptions = {}) {
    this.service = options.service ?? DEFAULT_SERVICE;
    this.account = options.account ?? DEFAULT_ACCOUNT;
    this.securityBin = options.securityBin ?? DEFAULT_SECURITY_BIN;
    this.envFallbackKey = options.envFallbackKey ?? DEFAULT_ENV_FALLBACK_KEY;
    this.platform = options.platform ?? process.platform;
  }

  async getApiKey(): Promise<string | null> {
    if (this.platform !== "darwin") {
      const value = process.env[this.envFallbackKey];
      return typeof value === "string" && value.length > 0 ? value : null;
    }
    const result = await this.runSecurity([
      "find-generic-password",
      "-s",
      this.service,
      "-a",
      this.account,
      "-w",
    ]);
    if (result.exitCode === 0) {
      return result.stdout.replace(/\r?\n$/, "");
    }
    if (result.exitCode === ITEM_NOT_FOUND_EXIT) {
      return null;
    }
    throw new KeychainAccessError(
      `security find-generic-password failed (exit=${result.exitCode}): ${result.stderr.trim()}`,
      result.exitCode,
    );
  }

  async setApiKey(key: string): Promise<void> {
    if (this.platform !== "darwin") {
      throw new KeychainUnsupportedError(
        `setApiKey is unsupported on ${this.platform}. Set ${this.envFallbackKey} env instead.`,
      );
    }
    const result = await this.runSecurity([
      "add-generic-password",
      "-s",
      this.service,
      "-a",
      this.account,
      "-w",
      key,
      "-U",
    ]);
    if (result.exitCode !== 0) {
      throw new KeychainAccessError(
        `security add-generic-password failed (exit=${result.exitCode}): ${result.stderr.trim()}`,
        result.exitCode,
      );
    }
  }

  async deleteApiKey(): Promise<void> {
    if (this.platform !== "darwin") {
      throw new KeychainUnsupportedError(
        `deleteApiKey is unsupported on ${this.platform}.`,
      );
    }
    const result = await this.runSecurity([
      "delete-generic-password",
      "-s",
      this.service,
      "-a",
      this.account,
    ]);
    if (result.exitCode === 0 || result.exitCode === ITEM_NOT_FOUND_EXIT) {
      return;
    }
    throw new KeychainAccessError(
      `security delete-generic-password failed (exit=${result.exitCode}): ${result.stderr.trim()}`,
      result.exitCode,
    );
  }

  private async runSecurity(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: [this.securityBin, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode: exitCode ?? 0, stdout, stderr };
  }
}
