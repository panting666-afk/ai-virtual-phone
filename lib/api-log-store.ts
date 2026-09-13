// lib/api-log-store.ts
// 底层模型调用日志存储（独立模块，避免 chat-engine ↔ api-helpers 循环依赖）。
// 聊天引擎（整段/流式/原生工具）与 simpleLLMCall（记忆总结、朋友圈、日历等
// 通用 LLM 调用）共用这份日志，统一在「底层调用大模型日志」面板查看。

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

export type DebugInfo = {
    id: string;
    characterName?: string;
    model?: string;
    messages: { role: string; content: string; marker?: string }[];
    /** 实际发往供应商的完整 JSON 请求体（不含鉴权请求头）。旧日志可能没有此字段。 */
    requestBody?: string;
    rawResponse: string;
    timestamp: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    /** 模型思维链（reasoning/CoT）原文，独立于回复内容存储，避免被清洗吞掉 */
    reasoning?: string;
    /** 调用来源：chat=聊天引擎、background=simpleLLMCall 后台功能（具体功能名看 characterName 标签）、qa=工坊答疑引擎 */
    source?: "chat" | "background" | "qa";
    /** 归属通道：qa 进工坊专用环，其余进底层调用日志环。分流只认这个显式字段，不看角色名 */
    channel?: "chat" | "qa";
};

// 底层调用日志环容量。原为 50：聊天请求与 18 处 simpleLLMCall 后台调用（记忆总结、
// NPC 生成、剧情、地图等）共享一个环，用户想看自己刚才那次聊天时很容易已被后台调用
// 挤掉，因此扩容。只按条数轮换；每条请求/响应均完整保存，不再做内容截断。
const MAX_API_LOGS = 150;
// 工坊环容量：只有答疑引擎写入，量小，维持原值。
const MAX_QA_API_LOGS = 50;
const API_LOGS_KEY = "ai_phone_api_logs_v1";
// 工坊（QA 助手）专用调用记录：与聊天/记忆等底层调用日志彻底隔离，
// 只在工坊界面右上角「调用记录」里查看，绝不混进聊天页的「底层调用大模型日志」。
const QA_LOGS_KEY = "ai_phone_qa_api_logs_v1";
registerKvMigration(API_LOGS_KEY);
registerKvMigration(QA_LOGS_KEY);

function _loadLogs(key: string): DebugInfo[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(key) : null;
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as DebugInfo[] : [];
    } catch { return []; }
}
function _saveLogs(key: string, logs: DebugInfo[]): void {
    try { kvSet(key, JSON.stringify(logs)); } catch { /* 日志失败不影响主流程 */ }
}

export function getApiLogs(): DebugInfo[] { return _loadLogs(API_LOGS_KEY); }
export function clearApiLogs(): void { try { kvRemove(API_LOGS_KEY); } catch { } }

/** 工坊专用调用记录（仅工坊 UI 读取，与底层日志完全隔离）。 */
export function getQaApiLogs(): DebugInfo[] { return _loadLogs(QA_LOGS_KEY); }
export function clearQaApiLogs(): void { try { kvRemove(QA_LOGS_KEY); } catch { } }

/** 追加一条完整调用日志（id/timestamp 自动生成），仅在超过数量上限时轮换最旧记录。 */
export function pushApiLog(entry: Omit<DebugInfo, "id" | "timestamp">): void {
    // 工坊（QA 助手）的调用单独归档，不进聊天页的底层调用日志。
    // 分流只认显式 channel 字段：角色名恰好叫「工坊」的聊天不会被误扔进工坊记录。
    const isQa = entry.channel === "qa";
    const key = isQa ? QA_LOGS_KEY : API_LOGS_KEY;
    const maxCount = isQa ? MAX_QA_API_LOGS : MAX_API_LOGS;
    try {
        const logs = _loadLogs(key);
        logs.push({
            ...entry,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
        });
        _saveLogs(key, logs.slice(-maxCount));
    } catch { /* 日志写入失败不影响主流程 */ }
}
