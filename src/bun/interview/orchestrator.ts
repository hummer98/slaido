/**
 * Interview Orchestrator (T019 plan §S9 + §S9b).
 *
 * - interview-start / answer / cancel / done と rubric-confirm / preset 周りの
 *   ロジックを `src/bun/index.ts` から切り出して、テスト可能な形にしたもの
 * - 依存は引数注入: serverInfo / runOneTurnFn / createSessionFn / deleteSessionFn /
 *   rubricStore / presetStore / send (WebView へのメッセージ送信)
 * - `interviewSessionIds` (Set<string>) を外から渡し、bridge.onEvent ハンドラ側で
 *   `if (interviewSessionIds.has(ev.sessionId)) return;` として除外する責務分担を保つ
 *   (Risk 5.4)
 */

import type { OpencodeServerInfo } from "../opencode/server-manager";
import {
  emptyRubricAxes,
  type DeckRubric,
  type DeckRubricAxes,
  type RubricPreset,
} from "../storage/rubric-types";
import type { RubricStore } from "../storage/rubric-store";
import type { PresetStore } from "../storage/preset-store";
import {
  countFilledAxes,
  createInterviewSession,
  deleteInterviewSession,
  InterviewRunnerError,
  mergeAxes,
  runOneTurn,
  shouldStopInterview,
} from "./interview-runner";

const MAX_QUESTIONS = 4;

export type InterviewServerMessage =
  | { type: "presets-list"; presets: RubricPreset[] }
  | {
      type: "interview-question";
      turnIndex: number;
      question: string;
      askedCount: number;
      maxQuestions: number;
    }
  | { type: "interview-done"; rubric: DeckRubric }
  | { type: "interview-error"; message: string }
  | { type: "preset-saved"; preset: RubricPreset };

export type SendFn = (msg: InterviewServerMessage) => void;

export interface InterviewSessionState {
  sessionId: string;
  seed: string;
  axes: DeckRubricAxes;
  /** これまでの確定 Q&A 履歴 (oldest first) */
  log: Array<{ q: string; a: string }>;
  /** 投げた質問数 (確定済 = log.length と同じ. ただし pending question は数えない) */
  askedCount: number;
  /** 次に answer で受け取るべき turnIndex. 0 から始まる */
  expectedTurnIndex: number;
  /** 直近 mainview に送った質問本文 (answer が未到着のとき log を更新するため) */
  pendingQuestion: string | null;
  abortController: AbortController;
}

export interface OrchestratorDeps {
  /** 起動中の opencode server info を取得する getter (起動前は null を返す) */
  getServerInfo(): OpencodeServerInfo | null;
  /** WebView へのメッセージ送信. void return */
  send: SendFn;
  rubricStore: RubricStore;
  presetStore: PresetStore;
  /**
   * interview 用 session id の Set. orchestrator は新規 session id をここに add し、
   * cancel / done / DELETE 時に必ず remove する.
   *
   * `bridge.onEvent` ハンドラ側で `if (interviewSessionIds.has(ev.sessionId)) return;`
   * として WebView への chat-event 転送を抑止する責務分担 (Risk 5.4).
   */
  interviewSessionIds: Set<string>;
  /** テスト差替用: createInterviewSession */
  createSessionFn?: typeof createInterviewSession;
  /** テスト差替用: deleteInterviewSession */
  deleteSessionFn?: typeof deleteInterviewSession;
  /** テスト差替用: runOneTurn */
  runOneTurnFn?: typeof runOneTurn;
  /** rubric が確定したときに呼ばれる callback (orchestrator から generate を駆動するための hook) */
  onRubricConfirmed?(args: {
    rubric: DeckRubric;
    seed: string;
  }): void | Promise<void>;
  /** logger (default: console.warn) */
  warn?(message: string, detail?: string): void;
  /** project id getter (rubric を保存する project の id). null なら save をスキップ */
  getActiveProjectId(): string | null;
}

export interface OrchestratorOptions {
  maxQuestions?: number;
}

/**
 * 1 回の interview 実行のライフサイクルを保持するオーケストレータ.
 *
 * - `start(seed)` で 1 問目を取りに行く
 * - `answer({ turnIndex, answer })` で次の turn を進める. turnIndex 不一致は drop+warn
 * - `cancel()` で AbortController.abort + DELETE session
 * - `confirmRubric({ rubric, alsoSavePreset, presetName })` で rubric を保存し、
 *   `onRubricConfirmed` callback で generate を起動する
 * - `listPresets()` / `usePreset(id)` も window 経由で呼ばれるが、ここはほぼ薄いラッパ
 */
export class InterviewOrchestrator {
  private active: InterviewSessionState | null = null;
  private readonly maxQuestions: number;

  constructor(
    private readonly deps: OrchestratorDeps,
    options: OrchestratorOptions = {},
  ) {
    this.maxQuestions = options.maxQuestions ?? MAX_QUESTIONS;
  }

  /** test/inspection 用: 現在の interview 状態を返す (read-only). */
  getState(): InterviewSessionState | null {
    return this.active;
  }

  async start(seed: string): Promise<void> {
    const info = this.deps.getServerInfo();
    if (!info) {
      this.deps.send({
        type: "interview-error",
        message: "opencode サーバが未起動のため interview を開始できません",
      });
      return;
    }
    // 二重 start は前の interview を畳んでから新規開始 (魔法に走りすぎないため強制 reset)
    if (this.active) {
      await this.cancel();
    }
    const ctrl = new AbortController();
    let sessionId: string;
    try {
      const createFn = this.deps.createSessionFn ?? createInterviewSession;
      sessionId = await createFn({
        serverInfo: info,
        signal: ctrl.signal,
      });
    } catch (err) {
      this.warn(
        "interview_start_failed",
        `${err instanceof Error ? err.message : String(err)}`,
      );
      this.deps.send({
        type: "interview-error",
        message: `interview の開始に失敗しました: ${(err as Error).message}`,
      });
      return;
    }

    this.deps.interviewSessionIds.add(sessionId);
    this.active = {
      sessionId,
      seed,
      axes: emptyRubricAxes(),
      log: [],
      askedCount: 0,
      expectedTurnIndex: 0,
      pendingQuestion: null,
      abortController: ctrl,
    };

    await this.advanceTurn();
  }

  async answer(args: { turnIndex: number; answer: string }): Promise<void> {
    if (!this.active) {
      this.warn(
        "interview_answer_dropped",
        `reason=no_active_interview turnIndex=${args.turnIndex}`,
      );
      return;
    }
    if (args.turnIndex !== this.active.expectedTurnIndex) {
      // T019 plan §S9: turnIndex mismatch は drop + warn
      this.warn(
        "interview_answer_turn_mismatch",
        `expected=${this.active.expectedTurnIndex} got=${args.turnIndex}`,
      );
      return;
    }
    if (this.active.pendingQuestion === null) {
      this.warn(
        "interview_answer_dropped",
        "reason=no_pending_question",
      );
      return;
    }
    // log に確定 Q&A を積む
    this.active.log.push({
      q: this.active.pendingQuestion,
      a: args.answer,
    });
    this.active.askedCount += 1;
    this.active.expectedTurnIndex += 1;
    this.active.pendingQuestion = null;

    await this.advanceTurn();
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    const { sessionId, abortController } = this.active;
    abortController.abort();
    this.deps.interviewSessionIds.delete(sessionId);
    const info = this.deps.getServerInfo();
    if (info) {
      const deleteFn = this.deps.deleteSessionFn ?? deleteInterviewSession;
      await deleteFn({ serverInfo: info, sessionId });
    }
    this.active = null;
  }

  /**
   * AI に次の 1 問を取りに行き、shouldStop なら interview-done を送る.
   *
   * - 実行中の active が前提. 呼び出し側は active を必ず set してから呼ぶ.
   */
  private async advanceTurn(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const info = this.deps.getServerInfo();
    if (!info) {
      this.deps.send({
        type: "interview-error",
        message: "opencode サーバが切断されました",
      });
      await this.cancel();
      return;
    }

    const runFn = this.deps.runOneTurnFn ?? runOneTurn;
    let turnOutput: Awaited<ReturnType<typeof runOneTurn>>;
    try {
      turnOutput = await runFn({
        serverInfo: info,
        sessionId: active.sessionId,
        seed: active.seed,
        rawInterviewLog: active.log,
        filledAxes: active.axes,
        askedCount: active.askedCount,
        maxQuestions: this.maxQuestions,
        signal: active.abortController.signal,
      });
    } catch (err) {
      if (err instanceof InterviewRunnerError && err.code === "ABORTED") {
        // cancel 経路: cleanup は cancel() 側で完了している想定
        return;
      }
      this.warn(
        "interview_runner_failed",
        err instanceof Error ? err.message : String(err),
      );
      this.deps.send({
        type: "interview-error",
        message: `インタビュー中にエラーが発生しました: ${(err as Error).message}`,
      });
      await this.cancel();
      return;
    }

    // 軸を merge する
    active.axes = mergeAxes(active.axes, turnOutput.updated_axes);
    const filled = countFilledAxes(active.axes);

    const stop = shouldStopInterview({
      askedCount: active.askedCount,
      filledAxisCount: filled,
      aiSaidDone: turnOutput.done,
      maxQuestions: this.maxQuestions,
    });

    if (stop) {
      // interview 終了: rubric を組み立てて送る
      const now = new Date().toISOString();
      const rubric: DeckRubric = {
        schemaVersion: 1,
        axes: active.axes,
        raw_interview_log: active.log.slice(),
        createdAt: now,
        updatedAt: now,
      };
      // session を片付け. 状態クリアは done 送信前に行う (二重 cancel を避ける)
      const sessionId = active.sessionId;
      this.active = null;
      this.deps.interviewSessionIds.delete(sessionId);
      const deleteFn = this.deps.deleteSessionFn ?? deleteInterviewSession;
      await deleteFn({ serverInfo: info, sessionId });
      this.deps.send({ type: "interview-done", rubric });
      return;
    }

    // 続行: 次の質問を mainview に送る
    if (turnOutput.next_question === null) {
      // shouldStop は false でも next_question が無い ≒ AI のミス. error にする.
      this.deps.send({
        type: "interview-error",
        message: "interview の質問生成に失敗しました (next_question=null)",
      });
      await this.cancel();
      return;
    }
    active.pendingQuestion = turnOutput.next_question;
    this.deps.send({
      type: "interview-question",
      turnIndex: active.expectedTurnIndex,
      question: turnOutput.next_question,
      askedCount: active.askedCount + 1, // 「これから聞く問」が何問目か
      maxQuestions: this.maxQuestions,
    });
  }

  async listPresets(): Promise<void> {
    const presets = await this.deps.presetStore.list();
    this.deps.send({ type: "presets-list", presets });
  }

  async confirmRubric(args: {
    rubric: DeckRubric;
    seed: string;
    alsoSavePreset: boolean;
    presetName?: string;
  }): Promise<void> {
    const projectId = this.deps.getActiveProjectId();
    if (projectId !== null) {
      try {
        await this.deps.rubricStore.save(projectId, args.rubric);
      } catch (err) {
        this.warn(
          "rubric_save_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (args.alsoSavePreset && args.presetName) {
      try {
        const preset = await this.deps.presetStore.save({
          name: args.presetName,
          rubric: args.rubric,
        });
        this.deps.send({ type: "preset-saved", preset });
      } catch (err) {
        this.warn(
          "preset_save_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    // active interview が残っていれば畳む (rubric-confirm は終了点なので)
    if (this.active) {
      const sessionId = this.active.sessionId;
      this.deps.interviewSessionIds.delete(sessionId);
      this.active = null;
      const info = this.deps.getServerInfo();
      if (info) {
        const deleteFn = this.deps.deleteSessionFn ?? deleteInterviewSession;
        await deleteFn({ serverInfo: info, sessionId });
      }
    }
    // generate 起動は呼び出し側 hook に委譲
    if (this.deps.onRubricConfirmed) {
      await this.deps.onRubricConfirmed({ rubric: args.rubric, seed: args.seed });
    }
  }

  private warn(event: string, detail: string): void {
    if (this.deps.warn) this.deps.warn(event, detail);
    else console.warn(`[interview-orchestrator] ${event}: ${detail}`);
  }
}
