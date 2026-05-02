/**
 * OpencodeServerManager — opencode serve サブプロセスのライフサイクル管理.
 *
 * - 起動: ポートを node:net で listen(0) → close で予約 → `--port=<n>` で渡す
 *   (opencode v1.14.29 の `--port=0` は OS 割当ではなく default 4096 になるため)
 * - 認証: OPENCODE_SERVER_PASSWORD = randomBytes(32).hex を env で渡す
 * - ヘルス: /global/health を 100ms ポーリング (default startupTimeoutMs=15s)
 * - 停止: SIGTERM → stopGracePeriodMs (default 5s) → SIGKILL
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as joinPath } from "node:path";
import type { Subprocess } from "bun";

import {
  assertBinaryExists,
  resolveOpencodeBinary,
} from "./binary-resolver";
import { log, warn as logWarn, error as logError, fmtErr } from "../logger";

/** ReadableStream から末尾の最大 maxBytes 分を文字列として取得する。 */
async function readStreamTail(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number = 4096,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged.length > maxBytes ? merged.slice(merged.length - maxBytes) : merged;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(buf);
}

export interface OpencodeServerInfo {
  baseUrl: string;
  password: string;
  username: string;
  pid: number;
}

export type OpencodeServerStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed";

export interface OpencodeServerLogger {
  info: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

export interface OpencodeServerManagerOptions {
  /** バイナリパスの上書き. テスト・dev 上書き両用 */
  binaryPath?: string;
  /** opencode を起動する cwd. default: <os.tmpdir()>/slaido-opencode */
  workingDirectory?: string;
  /** ヘルスチェック poll 間隔 (ms). default 100ms */
  healthPollIntervalMs?: number;
  /** 起動タイムアウト (ms). default 15_000 */
  startupTimeoutMs?: number;
  /** SIGTERM → SIGKILL 移行までの猶予 (ms). default 5_000 */
  stopGracePeriodMs?: number;
  /** ログハンドラ. 未指定なら console.* */
  logger?: OpencodeServerLogger;
  /** 追加 env (T010 などで OPENROUTER_API_KEY を入れる想定) */
  extraEnv?: Record<string, string>;
}

export class OpencodeServerStartError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OpencodeServerStartError";
  }
}

const DEFAULT_USERNAME = "opencode";

const defaultLogger: OpencodeServerLogger = {
  info: (msg) => {
    void log("opencode_info", `msg=${JSON.stringify(msg)}`);
  },
  error: (msg, err) => {
    void logError(
      "opencode_error",
      err ? `msg=${JSON.stringify(msg)} ${fmtErr(err)}` : `msg=${JSON.stringify(msg)}`,
    );
  },
};

async function reservePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolveP, rejectP) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectP);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        const port = addr.port;
        server.close((err) => {
          if (err) rejectP(err);
          else resolveP(port);
        });
      } else {
        server.close();
        rejectP(new Error("failed to obtain port from server.address()"));
      }
    });
  });
}

function generatePassword(): string {
  return randomBytes(32).toString("hex");
}

export class OpencodeServerManager {
  private status: OpencodeServerStatus = "idle";
  private subprocess: Subprocess | null = null;
  private info: OpencodeServerInfo | null = null;
  private startPromise: Promise<OpencodeServerInfo> | null = null;
  private stopPromise: Promise<void> | null = null;

  private readonly options: Required<
    Pick<
      OpencodeServerManagerOptions,
      "healthPollIntervalMs" | "startupTimeoutMs" | "stopGracePeriodMs"
    >
  > &
    OpencodeServerManagerOptions;

  private readonly logger: OpencodeServerLogger;

  constructor(options: OpencodeServerManagerOptions = {}) {
    this.options = {
      healthPollIntervalMs: 100,
      startupTimeoutMs: 15_000,
      stopGracePeriodMs: 5_000,
      ...options,
    };
    this.logger = options.logger ?? defaultLogger;
  }

  getStatus(): OpencodeServerStatus {
    return this.status;
  }

  getInfo(): OpencodeServerInfo | null {
    return this.info;
  }

  start(): Promise<OpencodeServerInfo> {
    if (this.status === "running" && this.info) {
      return Promise.resolve(this.info);
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<OpencodeServerInfo> {
    if (this.status === "running" && this.info) return this.info;
    this.status = "starting";

    const binaryPath = resolveOpencodeBinary({ override: this.options.binaryPath });
    try {
      assertBinaryExists(binaryPath);
    } catch (err) {
      this.status = "idle";
      throw new OpencodeServerStartError((err as Error).message, err);
    }

    const cwd =
      this.options.workingDirectory ?? joinPath(tmpdir(), "slaido-opencode");
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (err) {
      this.status = "idle";
      throw new OpencodeServerStartError(
        `failed to create cwd ${cwd}: ${(err as Error).message}`,
        err
      );
    }

    // opencode の権限ダイアログを抑止する。slaido は LLM がプロジェクト下の
    // slides/index.html を Write/Edit するのを前提にしており、ユーザー個人の
    // ローカル workspace なので blanket allow で安全。これをやらないと
    // permission-request イベントで bridge.sendMessage が UI 応答待ちで stall する。
    // 文字列 "allow" は全 tool に対する shorthand (opencode config schema の
    // PermissionConfig: PermissionActionConfig | PermissionRuleObject)。
    try {
      writeFileSync(
        joinPath(cwd, "opencode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            // ユーザのグローバル設定からプラグインや壊れたエントリを継承しない
            // (例: opencode-orchestrator のロード失敗ログを抑止)
            plugin: [],
            permission: "allow",
          },
          null,
          2,
        ),
      );
    } catch (err) {
      void logWarn(
        "opencode_config_write_failed",
        `cwd=${cwd} ${(err as Error).message}`,
      );
    }

    let port: number;
    try {
      port = await reservePort();
    } catch (err) {
      this.status = "idle";
      throw new OpencodeServerStartError(
        `failed to reserve port: ${(err as Error).message}`,
        err
      );
    }

    const password = generatePassword();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      ...(this.options.extraEnv ?? {}),
      OPENCODE_SERVER_PASSWORD: password,
    };

    const subprocess = Bun.spawn({
      cmd: [
        binaryPath,
        "serve",
        `--port=${port}`,
        "--hostname=127.0.0.1",
        // ユーザグローバルの opencode 設定 (~/.config/opencode/opencode.json) で
        // 指定された外部プラグインを読み込まない。slaido のセッションログを
        // 関係ない plugin の load 失敗で汚さないためと、依存外を排する一貫性のため。
        "--pure",
      ],
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.subprocess = subprocess;
    void log(
      "opencode_subprocess_spawned",
      `pid=${subprocess.pid} port=${port} cwd=${cwd}`,
    );

    subprocess.exited.then(async (code) => {
      // 想定外 exit 時は stderr の末尾を吸い上げて detail に含める。
      // running / starting 中の exit のみ crash 扱いとし、停止フローでの exit は無視。
      if (this.status === "running" || this.status === "starting") {
        this.status = "crashed";
        const tail = await readStreamTail(subprocess.stderr).catch(() => "");
        const truncated = tail.slice(-1000);
        void logError(
          "opencode_subprocess_crashed",
          `pid=${subprocess.pid} code=${code} stderrTail=${JSON.stringify(truncated)}`,
        );
        this.logger.error(
          `[opencode] subprocess exited unexpectedly (code=${code})`
        );
      } else {
        void log(
          "opencode_subprocess_exited",
          `pid=${subprocess.pid} code=${code} status=${this.status}`,
        );
      }
    });

    try {
      await this.waitForHealth({ baseUrl, password });
    } catch (err) {
      // 起動失敗時は stderr 末尾を含めて記録（外部コマンド失敗 policy）。
      const tail = await readStreamTail(subprocess.stderr).catch(() => "");
      void logError(
        "opencode_startup_failed",
        `pid=${subprocess.pid} ${fmtErr(err)} stderrTail=${JSON.stringify(tail.slice(-1000))}`,
      );
      this.logger.error("[opencode] startup failed, killing subprocess", err);
      try {
        subprocess.kill("SIGKILL");
      } catch (killErr) {
        // 既に exit 済み等で kill 失敗。ログだけ残して続行。
        void log("opencode_startup_kill_failed", fmtErr(killErr));
      }
      try {
        await subprocess.exited;
      } catch (exitErr) {
        // exit 監視の失敗は致命的ではないが情報として残す。
        void log("opencode_startup_exit_wait_failed", fmtErr(exitErr));
      }
      this.subprocess = null;
      this.status = "stopped";
      throw new OpencodeServerStartError(
        `opencode server did not become healthy within ${this.options.startupTimeoutMs}ms`,
        err
      );
    }

    const info: OpencodeServerInfo = {
      baseUrl,
      password,
      username: DEFAULT_USERNAME,
      pid: subprocess.pid,
    };
    this.info = info;
    this.status = "running";
    this.logger.info(`[slAIdo] opencode server ready: ${baseUrl}`);
    return info;
  }

  private async waitForHealth(args: {
    baseUrl: string;
    password: string;
  }): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    const auth = `Basic ${Buffer.from(`${DEFAULT_USERNAME}:${args.password}`).toString("base64")}`;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (this.subprocess?.exitCode != null) {
        throw new Error(
          `subprocess exited during startup (code=${this.subprocess.exitCode})`
        );
      }
      try {
        const res = await fetch(`${args.baseUrl}/global/health`, {
          headers: { Authorization: auth },
        });
        if (res.status === 200) {
          // body の解放は best-effort。残してもメモリリークにはならず、ログ価値も低い。
          await res.body?.cancel().catch(() => {});
          return;
        }
        lastError = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, this.options.healthPollIntervalMs));
    }
    throw lastError ?? new Error("startup timeout");
  }

  async health(): Promise<boolean> {
    if (this.status !== "running" || !this.info) return false;
    const auth = `Basic ${Buffer.from(`${this.info.username}:${this.info.password}`).toString("base64")}`;
    try {
      const res = await fetch(`${this.info.baseUrl}/global/health`, {
        headers: { Authorization: auth },
      });
      return res.status === 200;
    } catch (err) {
      // health check のネットワーク失敗は false 扱いで OK。debug 観察用に warn を残す。
      void logWarn("opencode_health_check_failed", fmtErr(err));
      return false;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.status === "stopped" || this.status === "idle") {
      return Promise.resolve();
    }
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    const subprocess = this.subprocess;
    if (!subprocess) {
      this.status = "stopped";
      return;
    }
    this.status = "stopping";
    try {
      subprocess.kill("SIGTERM");
    } catch (err) {
      // 既に exit 済み等で kill 失敗。ログだけ残して続行。
      void log("opencode_stop_sigterm_failed", fmtErr(err));
    }
    const timeoutSentinel = Symbol("timeout");
    const result = await Promise.race<unknown>([
      subprocess.exited,
      new Promise((r) =>
        setTimeout(() => r(timeoutSentinel), this.options.stopGracePeriodMs)
      ),
    ]);
    if (result === timeoutSentinel) {
      this.logger.info("[opencode] SIGTERM timed out, sending SIGKILL");
      try {
        subprocess.kill("SIGKILL");
      } catch (err) {
        // 既に exit 済み等で kill 失敗。
        void log("opencode_stop_sigkill_failed", fmtErr(err));
      }
      try {
        await subprocess.exited;
      } catch (err) {
        void log("opencode_stop_exit_wait_failed", fmtErr(err));
      }
    }
    this.subprocess = null;
    this.info = null;
    this.status = "stopped";
  }
}
