import type { CalendarScheduleItem } from "./calendar-types";
import { loadCharacters } from "./character-storage";
import { addChatContact, createOrGetSession } from "./chat-storage";
import {
    removeCalendarTimedWakeSchedules,
    saveTimedWakeSchedule,
    type TimedWakeSchedule,
} from "./timed-wake-storage";

function calendarStartTime(item: Pick<CalendarScheduleItem, "date" | "startTime">): number | null {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date);
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(item.startTime);
    if (!dateMatch || !timeMatch) return null;
    const value = new Date(
        Number(dateMatch[1]),
        Number(dateMatch[2]) - 1,
        Number(dateMatch[3]),
        Number(timeMatch[1]),
        Number(timeMatch[2]),
        0,
        0,
    ).getTime();
    return Number.isFinite(value) ? value : null;
}

function cancelRemoteSchedules(schedules: TimedWakeSchedule[]): void {
    if (schedules.length === 0) return;
    void import("./push-bailout-client").then(module => {
        for (const schedule of schedules) module.cancelBailoutKey(`timedwake:${schedule.id}`);
    }).catch(() => undefined);
}

export function clearCalendarItemReminder(calendarItemId: string): void {
    cancelRemoteSchedules(removeCalendarTimedWakeSchedules(calendarItemId));
}

/** Keep one exact-start reminder in sync with a user calendar item. */
export function syncCalendarItemReminder(item: CalendarScheduleItem): void {
    const previous = removeCalendarTimedWakeSchedules(item.id);

    const characterId = item.reminderCharacterId?.trim();
    if (!characterId || !loadCharacters().some(character => character.id === characterId)) {
        cancelRemoteSchedules(previous);
        return;
    }

    const fireAt = calendarStartTime(item);
    if (!fireAt || fireAt <= Date.now()) {
        cancelRemoteSchedules(previous);
        return;
    }

    addChatContact(characterId);
    const session = createOrGetSession(characterId);
    const now = Date.now();
    const location = item.location && item.location !== "无" ? `，地点：${item.location}` : "";
    const schedule: TimedWakeSchedule = {
        id: `calendar_reminder_${item.id}`,
        sessionId: session.id,
        characterId,
        createdAt: now,
        fireAt,
        delayMinutes: Math.max(1, Math.round((fireAt - now) / 60_000)),
        intent: `用户日程开始提醒：现在是“${item.title}”的开始时间（${item.date} ${item.startTime}-${item.endTime}${location}）。请自然、明确地提醒用户该做这件事了。`,
        source: "calendar",
        calendarItemId: item.id,
    };
    // 同一日程使用稳定 id，服务端新预约会幂等覆盖旧预约；只撤销不同 id 的历史残留，
    // 避免异步 DELETE 晚于 POST 抵达而把刚更新的提醒删掉。
    cancelRemoteSchedules(previous.filter(existing => existing.id !== schedule.id));
    saveTimedWakeSchedule(schedule);
    void import("./push-bailout-client").then(module => module.armTimedWakeBailout(schedule)).catch(() => undefined);
}
