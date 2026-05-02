import { describe, expect, test } from "bun:test";
import { decodeClientMessage } from "./host-message";

/**
 * 回帰テスト: Electrobun の host-message エンベロープを正しく剥がすこと。
 *
 * 過去事故 (初期スキャフォールディング以来潜伏): event.data を直接 parse して
 * いたため、{ data: { detail: payload } } を payload と誤認し、ready / generate
 * 等あらゆる正常メッセージが schema_invalid で握りつぶされていた。
 *
 * このテストは Electrobun のイベント形状 (electrobun/api/bun/proc/native.ts:
 * webviewEventHandler) を再現して decodeClientMessage を直接叩く。
 */
describe("decodeClientMessage", () => {
  function envelope(payload: unknown): unknown {
    // ElectrobunEvent { name: "host-message", data: { detail: <payload> } } の最小再現。
    return { name: "host-message", data: { detail: payload } };
  }

  test("ready: envelope を剥がして ok=true を返す", () => {
    const r = decodeClientMessage(envelope({ type: "ready" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg.type).toBe("ready");
  });

  test("generate: seedContent を含めて parse される", () => {
    const r = decodeClientMessage(envelope({ type: "generate", seedContent: "# title" }));
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "generate") {
      expect(r.msg.seedContent).toBe("# title");
    } else {
      throw new Error("expected generate");
    }
  });

  test("client-warn: event と detail を含めて parse される", () => {
    const r = decodeClientMessage(
      envelope({
        type: "client-warn",
        event: "generate_click_ignored",
        detail: "seedLen=0 turn=running",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "client-warn") {
      expect(r.msg.event).toBe("generate_click_ignored");
      expect(r.msg.detail).toBe("seedLen=0 turn=running");
    } else {
      throw new Error("expected client-warn");
    }
  });

  test("client-warn: detail なしでも parse される (optional)", () => {
    const r = decodeClientMessage(envelope({ type: "client-warn", event: "x" }));
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "client-warn") {
      expect(r.msg.event).toBe("x");
      expect(r.msg.detail).toBeUndefined();
    } else {
      throw new Error("expected client-warn");
    }
  });

  test("submit-api-key: sk-or- prefix と最低長を要求する", () => {
    const tooShort = decodeClientMessage(
      envelope({ type: "submit-api-key", key: "sk-or-short" }),
    );
    expect(tooShort.ok).toBe(false);

    const wrongPrefix = decodeClientMessage(
      envelope({ type: "submit-api-key", key: "sk-ant-1234567890123456789" }),
    );
    expect(wrongPrefix.ok).toBe(false);

    const ok = decodeClientMessage(
      envelope({ type: "submit-api-key", key: "sk-or-1234567890123456789" }),
    );
    expect(ok.ok).toBe(true);
  });

  test("非オブジェクト: kind=non_object を返す", () => {
    expect(decodeClientMessage(null)).toEqual({ ok: false, kind: "non_object" });
    expect(decodeClientMessage(undefined)).toEqual({ ok: false, kind: "non_object" });
    expect(decodeClientMessage("string")).toEqual({ ok: false, kind: "non_object" });
    expect(decodeClientMessage(42)).toEqual({ ok: false, kind: "non_object" });
  });

  test("schema_invalid: 不明な type を kind=schema_invalid で返す", () => {
    const r = decodeClientMessage(envelope({ type: "unknown-type", foo: "bar" }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "schema_invalid") {
      expect(r.dataType).toBe("object");
      expect(r.typeField).toBe("unknown-type");
      expect(r.keys).toContain("type");
    } else {
      throw new Error("expected schema_invalid");
    }
  });

  test("回帰: 旧バグ形 (event.data に payload 直置き) は schema_invalid になる", () => {
    // 旧コード経路 = envelope を作らず event.data に payload を直置き。
    // この形は Electrobun の実際のイベントとは一致しないため reject されるべき。
    const buggyEvent = { name: "host-message", data: { type: "generate", seedContent: "x" } };
    const r = decodeClientMessage(buggyEvent);
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "schema_invalid") {
      // 旧バグ時に main.log に出ていたまさにこの shape (typeField=undefined, keys=["type","seedContent"])。
      // detail key の不在をもって診断できる。
      expect(r.typeField).toBeUndefined();
      expect(r.keys).not.toContain("detail");
    } else {
      throw new Error("expected schema_invalid for legacy buggy shape");
    }
  });

  test("回帰: detail キーだけある envelope (旧バグの実観測形) も schema_invalid", () => {
    // バグ修正前に main.log に observed されていた shape:
    //   "dataType=object typeField=undefined keys=[\"detail\"]"
    // これは event.data に { detail: ... } が入っているが、その中身を見ずに
    // event.data 自体を parse してしまっていた状態。修正後は detail 中身まで降りるので
    // 同じ event 入力なら parse 通過する (ready の正常ケースと同じ) ことを確認。
    const sameAsReady = { name: "host-message", data: { detail: { type: "ready" } } };
    const r = decodeClientMessage(sameAsReady);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg.type).toBe("ready");
  });

  test("data フィールドが欠けている event: schema_invalid", () => {
    const r = decodeClientMessage({ name: "host-message" });
    expect(r.ok).toBe(false);
  });

  test("envelope.detail が undefined: schema_invalid", () => {
    const r = decodeClientMessage({ name: "host-message", data: { detail: undefined } });
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "schema_invalid") {
      expect(r.dataType).toBe("undefined");
    } else {
      throw new Error("expected schema_invalid");
    }
  });
});
