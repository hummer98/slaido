/**
 * `src/bun/opencode/` の barrel export.
 *
 * T012 / T013 が `from "./opencode"` で ChatBridge / ChatEvent / OpencodeServerManager 等を
 * 一元的に取り出せるようにする.
 */

export {
  OpencodeServerManager,
  OpencodeServerStartError,
} from "./server-manager";
export type {
  OpencodeServerInfo,
  OpencodeServerStatus,
  OpencodeServerLogger,
  OpencodeServerManagerOptions,
} from "./server-manager";

export {
  resolveOpencodeBinary,
  assertBinaryExists,
  detectArch,
} from "./binary-resolver";

export { ChatBridge, ChatBridgeInitError } from "./chat-bridge";
export type {
  ChatBridgeInitArgs,
  CreateSessionArgs,
  SendMessageArgs,
  ChatEventHandler,
  Unsubscribe,
} from "./chat-bridge";

export { normalizeEvent } from "./types";
export type {
  ChatEvent,
  ChatEventTextChunk,
  ChatEventReasoningChunk,
  ChatEventToolStatus,
  ChatEventPermissionRequest,
  ChatEventStepFinish,
  ChatEventError,
  ChatEventRaw,
  ChatEventForWire,
  StructuredOutputFormat,
  OpencodeRawEvent,
  OpencodePart,
  OpencodePermission,
  OpencodeToolState,
  AssistantMessage,
  UserMessage,
  Message,
} from "./types";
