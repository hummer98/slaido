/**
 * interview-runner — short-lived な opencode session を独立 REST 直叩きで操作し、
 * 1 ターン分の質問生成 / done 判定を AI に委ねる (T019 plan §2.1 — D1 採用案).
 *
 * 配線の意図:
 * - **chat-bridge は流用しない**。chat-bridge は subscribe を 1 本で全 session の event を
 *   集約する設計のため、interview 用 session を作ると interview の reasoning / tool-status
 *   が chat タブに漏れて UI が破綻する (Risk 5.4)
 * - 代わりに key-validator と同じ fetch 直叩き 3 ステップ:
 *     1. POST /session                        → { id }
 *     2. POST /session/{id}/message  (prompt) → { info, parts }
 *     3. DELETE /session/{id}                 → best-effort
 * - prompt のレスポンス JSON から `parts[].type === "text"` の text を連結し、
 *   `JSON.parse` して 1 turn 分の AI 出力を取り出す
 * - parse 失敗 / HTTP エラーは `InterviewRunnerError` で classify
 *
 * 引数注入:
 * - `fetchImpl` を注入できるようにし、テストで fetch をモックできる
 *   (key-validator / chat-bridge と同パターン)
 */

import type { OpencodeServerInfo } from "../opencode/server-manager";
import { INTERVIEW_MODEL } from "../auth/models";
import {
  INTERVIEW_SYSTEM_PROMPT,
  buildInterviewUserPrompt,
} from "./prompts";
import {
  DeckRubricAxesSchema,
  type DeckRubricAxes,
} from "../storage/rubric-types";
import { z } from "zod";

export type InterviewRunnerErrorCode =
  | "OPENCODE_ERROR"
  | "PARSE_FAILED"
  | "ABORTED";

export class InterviewRunnerError extends Error {
  readonly code: InterviewRunnerErrorCode;
  readonly httpStatus?: number;
  constructor(
    code: InterviewRunnerErrorCode,
    message?: string,
    options?: { cause?: unknown; httpStatus?: number },
  ) {
    super(message ?? code, options);
    this.name = "InterviewRunnerError";
    this.code = code;
    if (options?.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
  }
}

/**
 * runner の出力. axes は **部分更新** (この turn で AI が埋めた軸のみ).
 * 呼び出し側が前回の axes と merge する想定。
 */
export interface InterviewTurnOutput {
  done: boolean;
  next_question: string | null;
  updated_axes: Partial<DeckRubricAxes>;
}

/** AI 応答の JSON スキーマ. axes は部分更新を許容するため `partial`. */
const PartialAxesSchema = DeckRubricAxesSchema.partial();
const InterviewTurnSchema = z.object({
  done: z.boolean(),
  next_question: z.string().nullable(),
  updated_axes: PartialAxesSchema.default({}),
});

export interface RunOneTurnArgs {
  /** opencode server (BasicAuth + baseUrl). chat-bridge と同じ取り回し */
  serverInfo: OpencodeServerInfo;
  /** opencode session id. 新規作成は別関数 (createInterviewSession) で行う */
  sessionId: string;
  /** ユーザーが書いたシード本文 (毎ターン同じ) */
  seed: string;
  /** これまでの Q&A 履歴 (oldest first) */
  rawInterviewLog: ReadonlyArray<{ q: string; a: string }>;
  /** 現時点の filled_axes. JSON のままプロンプトに乗せる */
  filledAxes: DeckRubricAxes;
  /** 何問目か (0-indexed: 0 = 最初の質問) */
  askedCount: number;
  /** これ以上質問しない上限 (plan §2.3) */
  maxQuestions: number;
  /** AbortSignal — interview-cancel で in-flight を中断する */
  signal?: AbortSignal;
  /** テスト差替用 fetch 実装 */
  fetchImpl?: typeof fetch;
  /** タイムアウト ms. default 60_000 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

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

/** AbortSignal が複数あるときに任意のひとつが abort されたら abort される signal を作る. */
function combineSignals(
  signals: ReadonlyArray<AbortSignal | undefined>,
): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => Boolean(s));
  if (valid.length === 0) return AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  // AbortSignal.any が使えれば理想 (Bun は対応)
  if (typeof (AbortSignal as { any?: unknown }).any === "function") {
    return (
      AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }
    ).any(valid);
  }
  // フォールバック
  const ctrl = new AbortController();
  for (const s of valid) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/**
 * interview 用 session を作成する. session id を返す.
 * 呼び出し側 (orchestrator) はこの id を `interviewSessionIds` Set に登録し、
 * chat-bridge.onEvent から除外する責務を持つ (Risk 5.4).
 */
export async function createInterviewSession(args: {
  serverInfo: OpencodeServerInfo;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const fetchFn = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = combineSignals([args.signal, AbortSignal.timeout(timeoutMs)]);
  const auth = buildAuthHeader(args.serverInfo);
  let res: Response;
  try {
    res = await fetchFn(`${args.serverInfo.baseUrl}/session`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "interview" }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new InterviewRunnerError(
        "ABORTED",
        `POST /session aborted: ${(err as Error).message}`,
        { cause: err },
      );
    }
    throw new InterviewRunnerError(
      "OPENCODE_ERROR",
      `POST /session failed: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {});
    throw new InterviewRunnerError(
      "OPENCODE_ERROR",
      `POST /session HTTP ${res.status}`,
      { httpStatus: res.status },
    );
  }
  const json = (await res.json()) as { id?: unknown };
  if (typeof json.id !== "string" || json.id.length === 0) {
    throw new InterviewRunnerError(
      "OPENCODE_ERROR",
      `POST /session returned no id`,
    );
  }
  return json.id;
}

/**
 * 1 ターン分の prompt を投げて AI の JSON 出力を取得する.
 *
 * 失敗時は session を残したまま例外を返す (cleanup は呼び出し側 = orchestrator が DELETE する).
 */
export async function runOneTurn(args: RunOneTurnArgs): Promise<InterviewTurnOutput> {
  const fetchFn = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = combineSignals([args.signal, AbortSignal.timeout(timeoutMs)]);
  const auth = buildAuthHeader(args.serverInfo);
  const userPrompt = buildInterviewUserPrompt({
    seed: args.seed,
    filledAxes: args.filledAxes as Record<string, unknown>,
    rawInterviewLog: args.rawInterviewLog,
    askedCount: args.askedCount,
    maxQuestions: args.maxQuestions,
  });

  let res: Response;
  try {
    // SDK v1.14.29 の SessionPromptData.url に準拠 (key-validator は古い "/prompt" 表記)
    res = await fetchFn(
      `${args.serverInfo.baseUrl}/session/${args.sessionId}/message`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          parts: [{ type: "text", text: userPrompt }],
          system: INTERVIEW_SYSTEM_PROMPT,
          model: {
            providerID: INTERVIEW_MODEL.providerID,
            modelID: INTERVIEW_MODEL.modelID,
          },
        }),
        signal,
      },
    );
  } catch (err) {
    if (isAbortError(err)) {
      throw new InterviewRunnerError(
        "ABORTED",
        `prompt aborted: ${(err as Error).message}`,
        { cause: err },
      );
    }
    throw new InterviewRunnerError(
      "OPENCODE_ERROR",
      `prompt failed: ${(err as Error).message}`,
      { cause: err },
    );
  }

  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {});
    throw new InterviewRunnerError(
      "OPENCODE_ERROR",
      `prompt HTTP ${res.status}`,
      { httpStatus: res.status },
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new InterviewRunnerError(
      "PARSE_FAILED",
      `response body is not JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const text = extractAssistantText(body);
  if (text === null) {
    throw new InterviewRunnerError(
      "PARSE_FAILED",
      "assistant text part not found in response",
    );
  }

  return parseInterviewTurnOutput(text);
}

/**
 * /session/{id}/message レスポンスから assistant の text を連結して返す.
 * 取れなければ null.
 */
function extractAssistantText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const parts = (body as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const texts: string[] = [];
  for (const part of parts) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      texts.push((part as { text: string }).text);
    }
  }
  if (texts.length === 0) return null;
  return texts.join("").trim();
}

/**
 * AI が返した text を JSON.parse して InterviewTurnOutput に正規化する.
 *
 * 入力に余計な装飾 (```json ... ```) が混じるケースは reject せず一度だけ救済する
 * (system prompt で禁止しているが、Haiku 4.5 が稀にコードブロックを付けることがある)。
 */
export function parseInterviewTurnOutput(rawText: string): InterviewTurnOutput {
  const cleaned = stripCodeFences(rawText);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (err) {
    throw new InterviewRunnerError(
      "PARSE_FAILED",
      `not a JSON object: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const parsed = InterviewTurnSchema.safeParse(json);
  if (!parsed.success) {
    throw new InterviewRunnerError(
      "PARSE_FAILED",
      `schema mismatch: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return {
    done: parsed.data.done,
    next_question: parsed.data.next_question,
    updated_axes: parsed.data.updated_axes,
  };
}

function stripCodeFences(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (m && m[1]) return m[1].trim();
  return text.trim();
}

/**
 * interview を継続するか停止するかの判定 (plan §2.3).
 *
 * - AI が done:true → 停止
 * - askedCount >= maxQuestions → 停止
 * - filledAxisCount >= 4 (= 4 軸以上埋まったら) → 停止
 * - それ以外 → 続行
 */
export interface ShouldStopArgs {
  askedCount: number;
  filledAxisCount: number;
  aiSaidDone: boolean;
  maxQuestions: number;
  /** 軸網羅閾値. plan §2.3 で 4 を採用 */
  axisFillThreshold?: number;
}

export function shouldStopInterview(args: ShouldStopArgs): boolean {
  if (args.aiSaidDone) return true;
  if (args.askedCount >= args.maxQuestions) return true;
  const threshold = args.axisFillThreshold ?? 4;
  if (args.filledAxisCount >= threshold) return true;
  return false;
}

/**
 * interview session を best-effort で削除する (DELETE /session/{id}).
 *
 * orchestrator は cleanup ハンドラ + interview-cancel + done 時に必ず呼ぶ.
 */
export async function deleteInterviewSession(args: {
  serverInfo: OpencodeServerInfo;
  sessionId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const fetchFn = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth = buildAuthHeader(args.serverInfo);
  try {
    const res = await fetchFn(
      `${args.serverInfo.baseUrl}/session/${args.sessionId}`,
      {
        method: "DELETE",
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    await res.body?.cancel().catch(() => {});
  } catch {
    // best-effort
  }
}

/**
 * 軸の中で値が決まっている数を数える pure 関数 (orchestrator から共通利用).
 * `anti_patterns` は配列なので「空配列 == 未確定」とみなす.
 */
export function countFilledAxes(axes: DeckRubricAxes): number {
  let n = 0;
  if (axes.audience !== null) n++;
  if (axes.duration_min !== null) n++;
  if (axes.purpose !== null) n++;
  if (axes.success_criteria !== null) n++;
  if (axes.tone !== null) n++;
  if (axes.anti_patterns.length > 0) n++;
  return n;
}

/**
 * 部分更新 axes を既存 axes にマージして新しい完全 axes を返す pure 関数.
 *
 * - undefined の field は変更しない
 * - null は明示的に null に上書き (= AI が「該当なし」と判断したケースも許容)
 * - anti_patterns は配列で上書き (null 許容しない)
 */
export function mergeAxes(
  current: DeckRubricAxes,
  patch: Partial<DeckRubricAxes>,
): DeckRubricAxes {
  return {
    audience: patch.audience !== undefined ? patch.audience : current.audience,
    duration_min:
      patch.duration_min !== undefined ? patch.duration_min : current.duration_min,
    purpose: patch.purpose !== undefined ? patch.purpose : current.purpose,
    success_criteria:
      patch.success_criteria !== undefined
        ? patch.success_criteria
        : current.success_criteria,
    tone: patch.tone !== undefined ? patch.tone : current.tone,
    anti_patterns:
      patch.anti_patterns !== undefined ? patch.anti_patterns : current.anti_patterns,
  };
}
