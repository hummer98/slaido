/**
 * Orchestrator 統合テスト (T019 plan §S9b).
 *
 * fake interview-runner / fake create&deleteSession / 注入された rubricStore /
 * presetStore で以下のシナリオを検証する.
 *
 * 1. interview-start → 1 問目が interview-question として届く
 * 2. interview-answer (正しい turnIndex) → 次の問 / done なら interview-done
 * 3. interview-answer (stale turnIndex) → drop + warn
 * 4. interview-cancel → AbortController.abort + DELETE session
 * 5. rubric-confirm (alsoSavePreset:false) → RubricStore.save のみ
 * 6. rubric-confirm (alsoSavePreset:true) → RubricStore.save + PresetStore.save
 * 7. interviewSessionIds に session が登録される (bridge.onEvent filter のため)
 */

import { describe, expect, test } from "bun:test";

import { InterviewOrchestrator, type SendFn } from "./orchestrator";
import {
  emptyRubricAxes,
  type DeckRubric,
  type RubricPreset,
} from "../storage/rubric-types";
import type { OpencodeServerInfo } from "../opencode/server-manager";
import type { runOneTurn } from "./interview-runner";
import { InterviewRunnerError } from "./interview-runner";

const SERVER_INFO: OpencodeServerInfo = {
  baseUrl: "http://127.0.0.1:9999",
  username: "u",
  password: "p",
  pid: 1,
};

interface RecordedSend {
  msgs: unknown[];
  send: SendFn;
}

function makeSend(): RecordedSend {
  const msgs: unknown[] = [];
  const send: SendFn = (msg) => {
    msgs.push(msg);
  };
  return { msgs, send };
}

interface FakeRubricStore {
  saveCalls: Array<{ projectId: string; rubric: DeckRubric }>;
}

function makeRubricStore(): {
  store: { save: (id: string, r: DeckRubric) => Promise<void> };
  state: FakeRubricStore;
} {
  const state: FakeRubricStore = { saveCalls: [] };
  return {
    store: {
      save: async (projectId: string, rubric: DeckRubric) => {
        state.saveCalls.push({ projectId, rubric });
      },
    },
    state,
  };
}

interface FakePresetStore {
  saveCalls: Array<{ name: string; rubric: DeckRubric }>;
  list: RubricPreset[];
}

function makePresetStore(initial: RubricPreset[] = []) {
  const state: FakePresetStore = { saveCalls: [], list: initial };
  const presetStore = {
    save: async (input: { name: string; rubric: DeckRubric }) => {
      state.saveCalls.push(input);
      const preset: RubricPreset = {
        id: `id-${state.saveCalls.length}`,
        name: input.name,
        rubric: input.rubric,
        createdAt: "2026-05-04T00:00:00.000Z",
      };
      return preset;
    },
    list: async () => state.list,
  };
  return { store: presetStore, state };
}

type RunOneTurnImpl = typeof runOneTurn;

function buildDeps(opts: {
  runOneTurnImpl: RunOneTurnImpl;
  serverInfo?: OpencodeServerInfo | null;
  projectId?: string | null;
  rubricStore?: { save: (id: string, r: DeckRubric) => Promise<void> };
  presetStore?: {
    save: (input: { name: string; rubric: DeckRubric }) => Promise<RubricPreset>;
    list: () => Promise<RubricPreset[]>;
  };
  createSessionFn?: () => Promise<string>;
  deleteSessionFn?: (args: { sessionId: string }) => Promise<void>;
  warnFn?: (event: string, detail?: string) => void;
  onRubricConfirmed?: (args: {
    rubric: DeckRubric;
    seed: string;
  }) => void | Promise<void>;
}) {
  const recorder = makeSend();
  const interviewSessionIds = new Set<string>();
  const rubricStoreObj = opts.rubricStore ?? { save: async () => {} };
  const presetStoreObj =
    opts.presetStore ?? {
      save: async () => {
        throw new Error("not implemented");
      },
      list: async () => [],
    };
  const orchestrator = new InterviewOrchestrator({
    getServerInfo: () =>
      opts.serverInfo === null ? null : opts.serverInfo ?? SERVER_INFO,
    send: recorder.send,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rubricStore: rubricStoreObj as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    presetStore: presetStoreObj as any,
    interviewSessionIds,
    getActiveProjectId: () =>
      opts.projectId === undefined ? "proj-1" : opts.projectId,
    runOneTurnFn: opts.runOneTurnImpl,
    createSessionFn: (opts.createSessionFn
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (async () => opts.createSessionFn!())
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async () => "interview-sess") as any,
    deleteSessionFn: (opts.deleteSessionFn
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (async (args: { sessionId: string }) => opts.deleteSessionFn!(args))
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async () => {}) as any,
    ...(opts.onRubricConfirmed ? { onRubricConfirmed: opts.onRubricConfirmed } : {}),
    ...(opts.warnFn ? { warn: opts.warnFn } : {}),
  });
  return { orchestrator, recorder, interviewSessionIds };
}

describe("InterviewOrchestrator.start", () => {
  test("シナリオ1: 1 問目が interview-question として送信される", async () => {
    const runOneTurnImpl = (async () => ({
      done: false,
      next_question: "誰に話しますか？",
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const { orchestrator, recorder, interviewSessionIds } = buildDeps({
      runOneTurnImpl,
    });
    await orchestrator.start("seed");
    const ev = recorder.msgs.find(
      (m) => (m as { type: string }).type === "interview-question",
    ) as { turnIndex: number; question: string; askedCount: number };
    expect(ev).toBeDefined();
    expect(ev.turnIndex).toBe(0);
    expect(ev.question).toBe("誰に話しますか？");
    expect(ev.askedCount).toBe(1); // これから聞く 1 問目
    // session id は Set に登録されている (Risk 5.4)
    expect(interviewSessionIds.size).toBe(1);
  });
});

describe("InterviewOrchestrator.answer", () => {
  test("シナリオ2 (正しい turnIndex): 次の問が届く", async () => {
    let call = 0;
    const runOneTurnImpl = (async () => {
      call += 1;
      if (call === 1) {
        return {
          done: false,
          next_question: "Q1",
          updated_axes: { audience: "x" },
        };
      }
      return {
        done: false,
        next_question: "Q2",
        updated_axes: { duration_min: 10 },
      };
    }) as unknown as RunOneTurnImpl;

    const { orchestrator, recorder } = buildDeps({ runOneTurnImpl });
    await orchestrator.start("seed");
    await orchestrator.answer({ turnIndex: 0, answer: "A1" });
    const questions = recorder.msgs.filter(
      (m) => (m as { type: string }).type === "interview-question",
    );
    expect(questions).toHaveLength(2);
    const last = questions[1] as { question: string; turnIndex: number };
    expect(last.question).toBe("Q2");
    expect(last.turnIndex).toBe(1);
  });

  test("シナリオ2 (done:true): interview-done が届く", async () => {
    let call = 0;
    const runOneTurnImpl = (async () => {
      call += 1;
      if (call === 1) {
        return { done: false, next_question: "Q1", updated_axes: {} };
      }
      return {
        done: true,
        next_question: null,
        updated_axes: { audience: "social" },
      };
    }) as unknown as RunOneTurnImpl;
    const { orchestrator, recorder, interviewSessionIds } = buildDeps({
      runOneTurnImpl,
    });
    await orchestrator.start("seed");
    await orchestrator.answer({ turnIndex: 0, answer: "A1" });
    const done = recorder.msgs.find(
      (m) => (m as { type: string }).type === "interview-done",
    ) as { rubric: DeckRubric };
    expect(done).toBeDefined();
    expect(done.rubric.axes.audience).toBe("social");
    expect(done.rubric.raw_interview_log).toEqual([{ q: "Q1", a: "A1" }]);
    // done 時に session id は Set から除去される
    expect(interviewSessionIds.size).toBe(0);
  });

  test("シナリオ3 (stale turnIndex): drop + warn", async () => {
    const runOneTurnImpl = (async () => ({
      done: false,
      next_question: "Q1",
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const warnings: Array<{ event: string; detail?: string }> = [];
    const { orchestrator, recorder } = buildDeps({
      runOneTurnImpl,
      warnFn: (event, detail) => {
        warnings.push({ event, ...(detail !== undefined ? { detail } : {}) });
      },
    });
    await orchestrator.start("seed");
    const beforeCount = recorder.msgs.length;
    // turnIndex=99 は server 側 expected (=0) と一致しない → drop
    await orchestrator.answer({ turnIndex: 99, answer: "stale" });
    expect(recorder.msgs.length).toBe(beforeCount);
    expect(
      warnings.some((w) => w.event === "interview_answer_turn_mismatch"),
    ).toBe(true);
  });
});

describe("InterviewOrchestrator.cancel", () => {
  test("シナリオ4: cancel で interview session を畳み DELETE が呼ばれる", async () => {
    const runOneTurnImpl = (async () => ({
      done: false,
      next_question: "Q1",
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const deletedIds: string[] = [];
    const { orchestrator, interviewSessionIds } = buildDeps({
      runOneTurnImpl,
      deleteSessionFn: async ({ sessionId }) => {
        deletedIds.push(sessionId);
      },
    });
    await orchestrator.start("seed");
    expect(interviewSessionIds.size).toBe(1);
    await orchestrator.cancel();
    expect(deletedIds.length).toBeGreaterThanOrEqual(1);
    expect(interviewSessionIds.size).toBe(0);
    expect(orchestrator.getState()).toBeNull();
  });

  test("cancel: in-flight runner は AbortError で打ち切られる (ABORTED)", async () => {
    // runner が長時間 await するシナリオ. cancel 後 ABORTED で抜ける.
    const runOneTurnImpl = (async (args: { signal?: AbortSignal }) => {
      return await new Promise<never>((_, reject) => {
        const onAbort = () => {
          reject(
            new InterviewRunnerError("ABORTED", "test abort", { cause: new Error("abort") }),
          );
        };
        if (args.signal?.aborted) onAbort();
        else args.signal?.addEventListener("abort", onAbort);
      });
    }) as unknown as RunOneTurnImpl;
    const { orchestrator } = buildDeps({ runOneTurnImpl });
    const startP = orchestrator.start("seed");
    // start 内の advanceTurn が runner await に入るまで microtask を flush
    await new Promise((r) => setTimeout(r, 0));
    await orchestrator.cancel();
    await startP; // start 内の advanceTurn は ABORTED で抜ける (例外にしない)
    expect(orchestrator.getState()).toBeNull();
  });
});

describe("InterviewOrchestrator.confirmRubric", () => {
  const RUBRIC: DeckRubric = {
    schemaVersion: 1,
    axes: { ...emptyRubricAxes(), audience: "x" },
    raw_interview_log: [],
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  };

  test("シナリオ5: alsoSavePreset:false → RubricStore.save のみ", async () => {
    const { store: rubricStore, state: rubricState } = makeRubricStore();
    const { store: presetStore, state: presetState } = makePresetStore();
    const runOneTurnImpl = (async () => ({
      done: true,
      next_question: null,
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const generated: Array<{ rubric: DeckRubric; seed: string }> = [];
    const { orchestrator } = buildDeps({
      runOneTurnImpl,
      rubricStore,
      presetStore,
      onRubricConfirmed: async (args) => {
        generated.push(args);
      },
    });
    await orchestrator.confirmRubric({
      rubric: RUBRIC,
      seed: "seed-x",
      alsoSavePreset: false,
    });
    expect(rubricState.saveCalls).toHaveLength(1);
    expect(rubricState.saveCalls[0]?.projectId).toBe("proj-1");
    expect(presetState.saveCalls).toHaveLength(0);
    // generate が起動された
    expect(generated[0]?.seed).toBe("seed-x");
  });

  test("シナリオ6: alsoSavePreset:true → 両方 save される + preset-saved が送られる", async () => {
    const { store: rubricStore, state: rubricState } = makeRubricStore();
    const { store: presetStore, state: presetState } = makePresetStore();
    const runOneTurnImpl = (async () => ({
      done: true,
      next_question: null,
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const { orchestrator, recorder } = buildDeps({
      runOneTurnImpl,
      rubricStore,
      presetStore,
    });
    await orchestrator.confirmRubric({
      rubric: RUBRIC,
      seed: "seed-x",
      alsoSavePreset: true,
      presetName: "社内 LT",
    });
    expect(rubricState.saveCalls).toHaveLength(1);
    expect(presetState.saveCalls).toHaveLength(1);
    expect(presetState.saveCalls[0]?.name).toBe("社内 LT");
    const saved = recorder.msgs.find(
      (m) => (m as { type: string }).type === "preset-saved",
    ) as { preset: { name: string } };
    expect(saved).toBeDefined();
    expect(saved.preset.name).toBe("社内 LT");
  });

  test("alsoSavePreset:true でも presetName 未指定なら preset.save は呼ばれない", async () => {
    const { store: rubricStore } = makeRubricStore();
    const { store: presetStore, state: presetState } = makePresetStore();
    const runOneTurnImpl = (async () => ({
      done: true,
      next_question: null,
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const { orchestrator } = buildDeps({
      runOneTurnImpl,
      rubricStore,
      presetStore,
    });
    await orchestrator.confirmRubric({
      rubric: RUBRIC,
      seed: "x",
      alsoSavePreset: true,
    });
    expect(presetState.saveCalls).toHaveLength(0);
  });
});

describe("InterviewOrchestrator.listPresets", () => {
  test("presets-list を WebView へ送る", async () => {
    const fakePreset: RubricPreset = {
      id: "p1",
      name: "x",
      rubric: {
        schemaVersion: 1,
        axes: emptyRubricAxes(),
        raw_interview_log: [],
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const { store: presetStore } = makePresetStore([fakePreset]);
    const runOneTurnImpl = (async () => ({
      done: true,
      next_question: null,
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const { orchestrator, recorder } = buildDeps({
      runOneTurnImpl,
      presetStore,
    });
    await orchestrator.listPresets();
    const list = recorder.msgs.find(
      (m) => (m as { type: string }).type === "presets-list",
    ) as { presets: RubricPreset[] };
    expect(list).toBeDefined();
    expect(list.presets).toEqual([fakePreset]);
  });
});

describe("InterviewOrchestrator: bridge.onEvent filter", () => {
  test("シナリオ7: interviewSessionIds に session が登録される (filter の入口)", async () => {
    const runOneTurnImpl = (async () => ({
      done: false,
      next_question: "Q1",
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const { orchestrator, interviewSessionIds } = buildDeps({
      runOneTurnImpl,
    });
    await orchestrator.start("seed");
    const ids = Array.from(interviewSessionIds);
    expect(ids).toEqual(["interview-sess"]);
  });
});

describe("InterviewOrchestrator: server 未起動", () => {
  test("getServerInfo が null なら interview-error", async () => {
    const runOneTurnImpl = (async () => ({
      done: false,
      next_question: "Q1",
      updated_axes: {},
    })) as unknown as RunOneTurnImpl;
    const { orchestrator, recorder } = buildDeps({
      runOneTurnImpl,
      serverInfo: null,
    });
    await orchestrator.start("seed");
    const err = recorder.msgs.find(
      (m) => (m as { type: string }).type === "interview-error",
    );
    expect(err).toBeDefined();
  });
});
