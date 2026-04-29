/**
 * key-validator — opencode REST 経由で OpenRouter API キーの有効性を検証する.
 *
 * - 出典: docs/research/opencode-integration.md §2.1 (`client.session.prompt`) /
 *   §3.0 (`POST /session/:id/prompt`). opencode v1.14.29 を前提
 * - 手順:
 *   1. POST /session                 → { id }
 *   2. POST /session/{id}/prompt     → 200 = OK / 401 = unauthorized / ...
 *   3. DELETE /session/{id}          → best-effort
 * - timeout: AbortSignal.timeout(timeoutMs) で fetch を打ち切る (default 30s, plan F6)
 * - 401 は HTTP status のみで判定。レスポンス本文は破棄 (`res.body?.cancel()`)
 * - ログ出力でキー値を扱う場合は `maskApiKey()` でマスクすること (plan Rec2)
 */

import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getBundledTemplateRoot } from "../storage/app-paths";
import type { OpencodeServerInfo } from "../opencode/server-manager";
import { VALIDATION_MODEL } from "./models";

export type KeyValidationReason =
  | "unauthorized"
  | "network"
  | "rate_limit"
  | "unknown";

export class KeyValidationError extends Error {
  constructor(
    public readonly reason: KeyValidationReason,
    public readonly httpStatus?: number,
    message?: string,
  ) {
    super(message ?? `key validation failed: ${reason}`);
    this.name = "KeyValidationError";
  }
}

export interface ValidateApiKeyArgs {
  serverInfo: OpencodeServerInfo;
  /** 検証 prompt 本文. default "ping" */
  promptText?: string;
  /** AbortSignal.timeout の ms. default 30_000 (plan F6) */
  timeoutMs?: number;
  /** テスト差替用 fetch 実装 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TEXT = "ping";

function buildAuthHeader(info: OpencodeServerInfo): string {
  const credentials = `${info.username}:${info.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.message?.toLowerCase().includes("aborted"))
  );
}

function classifyHttpStatus(status: number): KeyValidationReason {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limit";
  return "unknown";
}

/**
 * OpenRouter API キーを opencode 経由で検証する.
 *
 * 200 が返れば resolve、それ以外は KeyValidationError を throw.
 */
export async function validateApiKey(args: ValidateApiKeyArgs): Promise<void> {
  const { serverInfo, fetchImpl } = args;
  const fetchFn: typeof fetch = fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const promptText = args.promptText ?? DEFAULT_PROMPT_TEXT;
  const auth = buildAuthHeader(serverInfo);
  const baseUrl = serverInfo.baseUrl;

  // 1. POST /session
  let sessionId: string;
  try {
    const res = await fetchFn(`${baseUrl}/session`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      throw new KeyValidationError(
        classifyHttpStatus(res.status),
        res.status,
        `POST /session failed: HTTP ${res.status}`,
      );
    }
    const json = (await res.json()) as { id?: unknown };
    if (typeof json.id !== "string" || json.id.length === 0) {
      throw new KeyValidationError(
        "unknown",
        res.status,
        `POST /session returned no id`,
      );
    }
    sessionId = json.id;
  } catch (err) {
    if (err instanceof KeyValidationError) throw err;
    if (isAbortError(err)) {
      throw new KeyValidationError(
        "network",
        undefined,
        `POST /session timeout: ${(err as Error).message}`,
      );
    }
    throw new KeyValidationError(
      "network",
      undefined,
      `POST /session failed: ${(err as Error).message}`,
    );
  }

  // 2. POST /session/{id}/prompt
  try {
    const res = await fetchFn(`${baseUrl}/session/${sessionId}/prompt`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: promptText }],
        model: {
          providerID: VALIDATION_MODEL.providerID,
          modelID: VALIDATION_MODEL.modelID,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 本文は読まずに破棄 (SSE 完了を待たない / plan F6)
    await res.body?.cancel().catch(() => {});
    if (res.status < 200 || res.status >= 300) {
      throw new KeyValidationError(
        classifyHttpStatus(res.status),
        res.status,
        `POST /session/${sessionId}/prompt failed: HTTP ${res.status}`,
      );
    }
  } catch (err) {
    // best-effort クリーンアップ (DELETE)
    await deleteSessionBestEffort(fetchFn, baseUrl, sessionId, auth, timeoutMs);
    if (err instanceof KeyValidationError) throw err;
    if (isAbortError(err)) {
      throw new KeyValidationError(
        "network",
        undefined,
        `POST /prompt timeout: ${(err as Error).message}`,
      );
    }
    throw new KeyValidationError(
      "network",
      undefined,
      `POST /prompt failed: ${(err as Error).message}`,
    );
  }

  // 3. DELETE /session/{id} (best-effort)
  await deleteSessionBestEffort(fetchFn, baseUrl, sessionId, auth, timeoutMs);
}

async function deleteSessionBestEffort(
  fetchFn: typeof fetch,
  baseUrl: string,
  sessionId: string,
  auth: string,
  timeoutMs: number,
): Promise<void> {
  try {
    const res = await fetchFn(`${baseUrl}/session/${sessionId}`, {
      method: "DELETE",
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // best-effort
  }
}

/**
 * ログ出力用にキー値をマスクする (plan Rec2).
 *
 * - 8 文字以下: "***"
 * - それ以外: 先頭 8 文字 + "**"
 */
export function maskApiKey(key: string): string {
  return key.length <= 8 ? "***" : `${key.slice(0, 8)}**`;
}

/**
 * 検証直前に tmpdir cwd へ最小 opencode.json をコピーする (plan F2 plan A).
 *
 * `templateRoot` 省略時は `getBundledTemplateRoot()` を使う.
 */
export async function writeMinimalConfigForValidation(
  cwd: string,
  templateRoot?: string,
): Promise<void> {
  await mkdir(cwd, { recursive: true });
  const root = templateRoot ?? getBundledTemplateRoot();
  const src = join(root, "opencode.json");
  const dst = join(cwd, "opencode.json");
  await copyFile(src, dst);
}
