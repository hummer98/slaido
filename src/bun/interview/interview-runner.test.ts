import { describe, expect, test } from "bun:test";

import {
  InterviewRunnerError,
  countFilledAxes,
  createInterviewSession,
  deleteInterviewSession,
  mergeAxes,
  parseInterviewTurnOutput,
  runOneTurn,
  shouldStopInterview,
} from "./interview-runner";
import { emptyRubricAxes, type DeckRubricAxes } from "../storage/rubric-types";
import { INTERVIEW_SYSTEM_PROMPT } from "./prompts";
import type { OpencodeServerInfo } from "../opencode/server-manager";

const SERVER_INFO: OpencodeServerInfo = {
  baseUrl: "http://127.0.0.1:9999",
  username: "u",
  password: "p",
  pid: 1,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("INTERVIEW_SYSTEM_PROMPT", () => {
  test("内部 6 軸の field 名を含む (interview prompt の語彙統一)", () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("audience");
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("duration_min");
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("purpose");
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("success_criteria");
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("tone");
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("anti_patterns");
  });

  test("max_questions / done フラグ言及あり", () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("max_questions");
    expect(INTERVIEW_SYSTEM_PROMPT).toContain("done");
  });
});

describe("parseInterviewTurnOutput", () => {
  test("done:false / next_question / updated_axes が取れる", () => {
    const out = parseInterviewTurnOutput(
      JSON.stringify({
        done: false,
        next_question: "誰に話す予定ですか？",
        updated_axes: { audience: null },
      }),
    );
    expect(out.done).toBe(false);
    expect(out.next_question).toBe("誰に話す予定ですか？");
    expect(out.updated_axes.audience).toBeNull();
  });

  test("done:true で next_question:null", () => {
    const out = parseInterviewTurnOutput(
      JSON.stringify({
        done: true,
        next_question: null,
        updated_axes: {
          audience: "社内エンジニア",
          purpose: "教育",
        },
      }),
    );
    expect(out.done).toBe(true);
    expect(out.next_question).toBeNull();
    expect(out.updated_axes.purpose).toBe("教育");
  });

  test("コードブロック装飾は剥がして parse する (Haiku の救済)", () => {
    const out = parseInterviewTurnOutput(
      "```json\n{\"done\":true,\"next_question\":null,\"updated_axes\":{}}\n```",
    );
    expect(out.done).toBe(true);
  });

  test("壊れた JSON は PARSE_FAILED", () => {
    let caught: unknown;
    try {
      parseInterviewTurnOutput("not json");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InterviewRunnerError);
    expect((caught as InterviewRunnerError).code).toBe("PARSE_FAILED");
  });

  test("schema 不一致 (purpose に未知の値) も PARSE_FAILED", () => {
    let caught: unknown;
    try {
      parseInterviewTurnOutput(
        JSON.stringify({
          done: false,
          next_question: "x",
          updated_axes: { purpose: "知らない目的" },
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InterviewRunnerError);
    expect((caught as InterviewRunnerError).code).toBe("PARSE_FAILED");
  });

  test("updated_axes 省略時は空オブジェクトに正規化される", () => {
    const out = parseInterviewTurnOutput(
      JSON.stringify({ done: false, next_question: "x" }),
    );
    expect(out.updated_axes).toEqual({});
  });
});

describe("shouldStopInterview", () => {
  test("AI が done:true → 停止", () => {
    expect(
      shouldStopInterview({
        askedCount: 1,
        filledAxisCount: 1,
        aiSaidDone: true,
        maxQuestions: 4,
      }),
    ).toBe(true);
  });

  test("askedCount >= maxQuestions → 停止", () => {
    expect(
      shouldStopInterview({
        askedCount: 4,
        filledAxisCount: 0,
        aiSaidDone: false,
        maxQuestions: 4,
      }),
    ).toBe(true);
  });

  test("4 軸埋まれば停止 (default threshold=4)", () => {
    expect(
      shouldStopInterview({
        askedCount: 2,
        filledAxisCount: 4,
        aiSaidDone: false,
        maxQuestions: 4,
      }),
    ).toBe(true);
  });

  test("3 問終了 + 3 軸埋め → 続行 (まだ余裕)", () => {
    expect(
      shouldStopInterview({
        askedCount: 3,
        filledAxisCount: 3,
        aiSaidDone: false,
        maxQuestions: 4,
      }),
    ).toBe(false);
  });
});

describe("countFilledAxes", () => {
  test("emptyRubricAxes は 0", () => {
    expect(countFilledAxes(emptyRubricAxes())).toBe(0);
  });

  test("audience だけ埋めれば 1", () => {
    const axes: DeckRubricAxes = { ...emptyRubricAxes(), audience: "x" };
    expect(countFilledAxes(axes)).toBe(1);
  });

  test("anti_patterns は空配列なら 0、何か入れば 1 を加算", () => {
    expect(
      countFilledAxes({ ...emptyRubricAxes(), anti_patterns: [] }),
    ).toBe(0);
    expect(
      countFilledAxes({ ...emptyRubricAxes(), anti_patterns: ["x"] }),
    ).toBe(1);
  });

  test("全軸埋めれば 6", () => {
    expect(
      countFilledAxes({
        audience: "a",
        duration_min: 10,
        purpose: "教育",
        success_criteria: "ok",
        tone: "落ち着き",
        anti_patterns: ["x"],
      }),
    ).toBe(6);
  });
});

describe("mergeAxes", () => {
  test("undefined は変更しない / null は上書きする", () => {
    const base: DeckRubricAxes = {
      audience: "old",
      duration_min: 5,
      purpose: "教育",
      success_criteria: null,
      tone: null,
      anti_patterns: [],
    };
    const merged = mergeAxes(base, {
      audience: "new",
      duration_min: undefined,
      tone: null,
    });
    expect(merged.audience).toBe("new");
    expect(merged.duration_min).toBe(5);
    expect(merged.tone).toBeNull();
  });

  test("anti_patterns は patch があれば上書き / なければ既存維持", () => {
    const base: DeckRubricAxes = {
      ...emptyRubricAxes(),
      anti_patterns: ["a"],
    };
    expect(mergeAxes(base, {}).anti_patterns).toEqual(["a"]);
    expect(
      mergeAxes(base, { anti_patterns: ["b", "c"] }).anti_patterns,
    ).toEqual(["b", "c"]);
  });
});

describe("runOneTurn (fetch モック注入)", () => {
  test("正常系: assistant text を JSON.parse して TurnOutput を返す", async () => {
    const fetches: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetches.push({ url: String(url), init });
      // /session/{id}/message のレスポンス
      return jsonResponse(200, {
        info: {},
        parts: [
          {
            type: "text",
            text: JSON.stringify({
              done: false,
              next_question: "誰に話しますか？",
              updated_axes: {},
            }),
          },
        ],
      });
    }) as unknown as typeof fetch;

    const out = await runOneTurn({
      serverInfo: SERVER_INFO,
      sessionId: "sess-1",
      seed: "seed",
      rawInterviewLog: [],
      filledAxes: emptyRubricAxes(),
      askedCount: 0,
      maxQuestions: 4,
      fetchImpl,
    });
    expect(out.next_question).toBe("誰に話しますか？");
    expect(out.done).toBe(false);
    // POST /session/{id}/message に送られている
    expect(fetches[0]?.url).toContain("/session/sess-1/message");
    // body に system / model が含まれる (interview prompt 経路の確認)
    const body = JSON.parse(fetches[0]?.init?.body as string);
    expect(body.system).toContain("audience");
    expect(body.model.modelID).toBe("anthropic/claude-haiku-4.5");
  });

  test("HTTP 5xx → OPENCODE_ERROR", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("", { status: 500 })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await runOneTurn({
        serverInfo: SERVER_INFO,
        sessionId: "sess-1",
        seed: "x",
        rawInterviewLog: [],
        filledAxes: emptyRubricAxes(),
        askedCount: 0,
        maxQuestions: 4,
        fetchImpl,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InterviewRunnerError);
    expect((caught as InterviewRunnerError).code).toBe("OPENCODE_ERROR");
    expect((caught as InterviewRunnerError).httpStatus).toBe(500);
  });

  test("壊れた JSON 本文 → PARSE_FAILED", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse(200, {
        parts: [{ type: "text", text: "not a json" }],
      })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await runOneTurn({
        serverInfo: SERVER_INFO,
        sessionId: "sess-1",
        seed: "x",
        rawInterviewLog: [],
        filledAxes: emptyRubricAxes(),
        askedCount: 0,
        maxQuestions: 4,
        fetchImpl,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InterviewRunnerError);
    expect((caught as InterviewRunnerError).code).toBe("PARSE_FAILED");
  });

  test("text part が無い → PARSE_FAILED", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse(200, {
        parts: [{ type: "tool", text: "ignored" }],
      })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await runOneTurn({
        serverInfo: SERVER_INFO,
        sessionId: "sess-1",
        seed: "x",
        rawInterviewLog: [],
        filledAxes: emptyRubricAxes(),
        askedCount: 0,
        maxQuestions: 4,
        fetchImpl,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InterviewRunnerError);
    expect((caught as InterviewRunnerError).code).toBe("PARSE_FAILED");
  });

  test("AbortSignal が abort 済みなら ABORTED 扱い", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl: typeof fetch = (async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      // 実 fetch と同様 signal を尊重して AbortError を throw する
      if (init?.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return jsonResponse(200, { parts: [] });
    }) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await runOneTurn({
        serverInfo: SERVER_INFO,
        sessionId: "sess-1",
        seed: "x",
        rawInterviewLog: [],
        filledAxes: emptyRubricAxes(),
        askedCount: 0,
        maxQuestions: 4,
        fetchImpl,
        signal: ctrl.signal,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InterviewRunnerError);
    expect((caught as InterviewRunnerError).code).toBe("ABORTED");
  });
});

describe("createInterviewSession", () => {
  test("POST /session で id を取って返す", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse(200, { id: "new-sess" })) as unknown as typeof fetch;
    const id = await createInterviewSession({
      serverInfo: SERVER_INFO,
      fetchImpl,
    });
    expect(id).toBe("new-sess");
  });

  test("HTTP エラー → OPENCODE_ERROR", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("", { status: 401 })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await createInterviewSession({ serverInfo: SERVER_INFO, fetchImpl });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InterviewRunnerError);
    expect((caught as InterviewRunnerError).code).toBe("OPENCODE_ERROR");
  });
});

describe("deleteInterviewSession", () => {
  test("失敗しても throw しない (best-effort)", async () => {
    const fetchImpl: typeof fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await deleteInterviewSession({
      serverInfo: SERVER_INFO,
      sessionId: "x",
      fetchImpl,
    });
    // ここまで例外無しで来れれば OK
  });

  test("成功時は DELETE /session/{id} を呼ぶ", async () => {
    const fetches: string[] = [];
    const fetchImpl: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetches.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await deleteInterviewSession({
      serverInfo: SERVER_INFO,
      sessionId: "abc",
      fetchImpl,
    });
    expect(fetches[0]).toBe(`DELETE ${SERVER_INFO.baseUrl}/session/abc`);
  });
});
