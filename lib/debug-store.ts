// lib/debug-store.ts
// Lightweight global store: ChatRoom writes current session+messages, DebugPromptPanel reads.

import type { ChatSession, ChatMessage } from "./chat-storage";
import type { LLMContentPart } from "./llm-prompt-assembler";

export type DebugChatState = { session: ChatSession; messages: ChatMessage[] } | null;
export type DebugPromptSnapshot = {
    id: string;
    timestamp: string;
    requestKind: "completion" | "native-tools" | "native-tools-stream";
    provider: string;
    providerKind: string;
    model: string;
    appId: string;
    appTags?: string[];
    sessionId?: string;
    characterName?: string;
    presetName?: string;
    messages: { role: string; content: string | LLMContentPart[]; marker?: string }[];
    /** 供应商会合并进 system 的瞬时上下文，仅用于单独显眼展示，不参与消息/token 统计。 */
    spotlightMessages?: { role: string; content: string | LLMContentPart[]; marker?: string }[];
    /** 只保留请求体字符数用于发送前估算，不在查看器或日志中保存/展示完整 JSON。 */
    requestBodyChars?: number;
    /** 请求完成后由供应商返回的实测 token；预览阶段通常不存在。 */
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    tools?: { name: string; description?: string }[];
};

let _state: DebugChatState = null;
const _listeners = new Set<() => void>();
let _promptSnapshot: DebugPromptSnapshot | null = null;
const _promptListeners = new Set<() => void>();

export function setDebugChatState(s: DebugChatState): void {
    _state = s;
    _listeners.forEach(fn => fn());
}

export function getDebugChatState(): DebugChatState {
    return _state;
}

export function subscribeDebugChatState(fn: () => void): () => void {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
}

export function setDebugPromptSnapshot(snapshot: DebugPromptSnapshot): void {
    _promptSnapshot = snapshot;
    _promptListeners.forEach(fn => fn());
}

export function getDebugPromptSnapshot(): DebugPromptSnapshot | null {
    return _promptSnapshot;
}

export function subscribeDebugPromptSnapshot(fn: () => void): () => void {
    _promptListeners.add(fn);
    return () => { _promptListeners.delete(fn); };
}
