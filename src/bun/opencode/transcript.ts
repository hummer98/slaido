/**
 * TranscriptLogger — opencode の `client.app.log` を経由して
 * `~/.local/share/opencode/log/<timestamp>.log` に slaido 由来のメタデータを inject する.
 *
 * docs/logging-policy.md §「opencode セッションログ拡張」参照.
 *
 * - main.log と完全独立 (二重出力許容)。chat-bridge / logger.ts には触らない.
 * - client は遅延参照 (`getClient` callback)。bootstrap 直後の `slaido_started` は
 *   client が未初期化のため drop + 1 度だけ warn という想定動作.
 * - `app.log` 自体は fire-and-forget。reject しても呼び出し側へ throw しない.
 */
import { createHash } from "node:crypto";
import type { OpencodeClient } from "@opencode-ai/sdk";

import { warn, fmtErr } from "../logger";
import pkg from "../../../package.json" with { type: "json" };

const SLAIDO_VERSION: string = (pkg as { version: string }).version;

const SERVICE_NAME = "slaido";
const ERR_STACK_MAX_LEN = 800;

type LogLevel = "debug" | "info" | "error" | "warn";

export interface TranscriptLoggerLike {
  log(event: string, extra?: Record<string, unknown>): void;
  error(event: string, err: unknown, extra?: Record<string, unknown>): void;
}

export interface TranscriptLoggerOptions {
  getClient: () => OpencodeClient | null;
  baseExtra: Record<string, unknown>;
}

export class TranscriptLogger implements TranscriptLoggerLike {
  private readonly getClient: () => OpencodeClient | null;
  private readonly baseExtra: Record<string, unknown>;
  private warnedClientUnavailable = false;

  constructor(opts: TranscriptLoggerOptions) {
    this.getClient = opts.getClient;
    this.baseExtra = opts.baseExtra;
  }

  log(event: string, extra?: Record<string, unknown>): void {
    this.emit("info", event, extra);
  }

  error(event: string, err: unknown, extra?: Record<string, unknown>): void {
    const e = err instanceof Error ? err : new Error(String(err));
    const stack = (e.stack ?? "").slice(0, ERR_STACK_MAX_LEN);
    const merged: Record<string, unknown> = {
      ...(extra ?? {}),
      errMessage: e.message,
      errStack: stack,
    };
    this.emit("error", event, merged);
  }

  private emit(
    level: LogLevel,
    event: string,
    perEventExtra?: Record<string, unknown>,
  ): void {
    const client = this.getClient();
    if (!client) {
      if (!this.warnedClientUnavailable) {
        this.warnedClientUnavailable = true;
        void warn(
          "transcript_log_failed",
          `event=${event} reason=client_unavailable`,
        );
      }
      return;
    }
    const extra: Record<string, unknown> = {
      ...this.baseExtra,
      ...(perEventExtra ?? {}),
    };
    void client.app
      .log({
        body: {
          service: SERVICE_NAME,
          level,
          message: event,
          extra,
        },
      })
      .catch((e: unknown) => {
        void warn("transcript_log_failed", `event=${event} ${fmtErr(e)}`);
      });
  }
}

export function hashSeed(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

export function buildBaseExtra(): Record<string, unknown> {
  return {
    slaidoVersion: SLAIDO_VERSION,
    buildSha: process.env.SLAIDO_BUILD_SHA ?? null,
    slaidoProcessId: process.pid,
    slaidoChannel: process.env.ELECTROBUN_CHANNEL ?? "dev",
  };
}
