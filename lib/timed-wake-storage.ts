import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const TIMED_WAKE_SCHEDULES_KEY = "ai_phone_timed_wake_schedules_v1";

registerKvMigration(TIMED_WAKE_SCHEDULES_KEY);

export type TimedWakeSchedule = {
    id: string;
    sessionId: string;
    characterId: string;
    fireAt: number;
    createdAt: number;
    delayMinutes: number;
    intent: string;
    /** 创建来源：tool=角色自己约的（"你当时想着"视角）/ user=用户预约（"TA拜托你"视角）。缺省按 tool。 */
    source?: "tool" | "user" | "calendar";
    /** 关联的用户日程；用于更新/删除日程时同步取消提醒。 */
    calendarItemId?: string;
    calendarTitle?: string;
    calendarLocation?: string;
};

export function makeTimedWakeId(sessionId: string): string {
    return `timed_wake_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadTimedWakeSchedules(): TimedWakeSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(TIMED_WAKE_SCHEDULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isTimedWakeSchedule);
    } catch {
        return [];
    }
}

function saveTimedWakeSchedules(schedules: TimedWakeSchedule[]): void {
    if (typeof window === "undefined") return;
    kvSet(TIMED_WAKE_SCHEDULES_KEY, JSON.stringify(schedules));
}

export function saveTimedWakeSchedule(schedule: TimedWakeSchedule): void {
    const all = loadTimedWakeSchedules();
    const next = schedule.source === "calendar"
        ? all.filter(item => item.source !== "calendar" || item.calendarItemId !== schedule.calendarItemId)
        : all.filter(item => item.source === "calendar" || item.sessionId !== schedule.sessionId);
    next.push(schedule);
    saveTimedWakeSchedules(next);
}

export function clearTimedWakeSchedule(sessionId: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.sessionId !== sessionId));
}

export function removeTimedWakeSchedule(id: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.id !== id));
}

export function removeCalendarReminder(itemId: string): string[] {
    const all = loadTimedWakeSchedules();
    const removed = all.filter(item => item.source === "calendar" && item.calendarItemId === itemId).map(item => item.id);
    saveTimedWakeSchedules(all.filter(item => item.source !== "calendar" || item.calendarItemId !== itemId));
    return removed;
}

function isTimedWakeSchedule(value: unknown): value is TimedWakeSchedule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<TimedWakeSchedule>;
    return typeof item.id === "string"
        && typeof item.sessionId === "string"
        && typeof item.characterId === "string"
        && typeof item.fireAt === "number"
        && typeof item.createdAt === "number"
        && typeof item.delayMinutes === "number"
        && typeof item.intent === "string";
}
