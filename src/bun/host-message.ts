/**
 * WebView (mainview) → Bun の host-message プロトコル定義とデコーダ。
 *
 * Electrobun の host-message は以下のエンベロープで届く
 * (electrobun/api/bun/proc/native.ts: webviewEventHandler):
 *
 *   event = ElectrobunEvent {
 *     name: "host-message",
 *     data: { detail: <user payload> },  // ← __electrobunSendToHost(payload) で渡したもの
 *   }
 *
 * ペイロード本体は event.data.detail にある。直接 event.data を見ると envelope を
 * payload と誤認して必ず schema 不一致になる (初期スキャフォールディング以来の潜在バグ)。
 */

import { z } from "zod";

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("chat"), content: z.string() }),
  z.object({ type: z.literal("chat-cancel") }),
  z.object({ type: z.literal("generate"), seedContent: z.string() }),
  z.object({
    type: z.literal("submit-api-key"),
    key: z.string().min(20).startsWith("sk-or-"),
  }),
  z.object({ type: z.literal("open-signup-url") }),
  z.object({ type: z.literal("reset-api-key") }),
  z.object({ type: z.literal("export-pdf") }),
  z.object({ type: z.literal("export-html-zip") }),
  z.object({
    type: z.literal("client-warn"),
    event: z.string().min(1),
    detail: z.string().optional(),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type DecodeResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; kind: "non_object" }
  | {
      ok: false;
      kind: "schema_invalid";
      dataType: string;
      typeField: unknown;
      keys: string[];
      issuesJson: string;
    };

export function decodeClientMessage(event: unknown): DecodeResult {
  if (typeof event !== "object" || event === null) {
    return { ok: false, kind: "non_object" };
  }
  const envelope = (event as Record<string, unknown>).data as
    | Record<string, unknown>
    | undefined;
  const data =
    envelope && typeof envelope === "object" ? envelope["detail"] : undefined;
  const parsed = ClientMessageSchema.safeParse(data);
  if (parsed.success) {
    return { ok: true, msg: parsed.data };
  }
  // 機密情報配慮: type / keys のみ。値 (seedContent / API key 本体等) は含めない。
  const dataType = data === null ? "null" : typeof data;
  let dataKeys: string[] = [];
  let typeField: unknown = undefined;
  if (data && typeof data === "object") {
    dataKeys = Object.keys(data as Record<string, unknown>).slice(0, 10);
    typeField = (data as Record<string, unknown>)["type"];
  }
  return {
    ok: false,
    kind: "schema_invalid",
    dataType,
    typeField,
    keys: dataKeys,
    issuesJson: JSON.stringify(parsed.error.issues.slice(0, 3)),
  };
}
