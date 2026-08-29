import type { CalendarScheduleItem } from "./calendar-types";
import { loadChatSessions } from "./chat-storage";
import { makeTimedWakeId, removeCalendarReminder, saveTimedWakeSchedule } from "./timed-wake-storage";

function getReminderFireAt(item: Pick<CalendarScheduleItem, "date" | "startTime">): number | null {
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date);
    const time = /^(\d{2}):(\d{2})$/.exec(item.startTime);
    if (!matched || !time) return null;
    const fireAt = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]), Number(time[1]), Number(time[2])).getTime();
    return Number.isFinite(fireAt) ? fireAt : null;
}

export function syncCalendarReminder(item: CalendarScheduleItem, preferredSessionId?: string): boolean {
    cancelCalendarReminder(item.id);
    if (!item.reminderEnabled || !item.reminderCharacterId) return false;
    const fireAt = getReminderFireAt(item);
    if (!fireAt || fireAt <= Date.now()) return false;
    const session = preferredSessionId
        ? loadChatSessions().find(value => value.id === preferredSessionId && value.contactId === item.reminderCharacterId && !value.isGroup)
        : loadChatSessions()
            .filter(value => value.contactId === item.reminderCharacterId && !value.isGroup)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!session) return false;

    const schedule = {
        id: makeTimedWakeId(session.id),
        sessionId: session.id,
        characterId: item.reminderCharacterId,
        createdAt: Date.now(),
        fireAt,
        delayMinutes: Math.max(1, Math.round((fireAt - Date.now()) / 60_000)),
        intent: `提醒用户：现在是日程「${item.title}」的开始时间（${item.date} ${item.startTime}，地点：${item.location || "未定"}）。请自然地提醒用户，不要把它说成是你自己约的主动联系。`,
        source: "calendar",
        calendarItemId: item.id,
        calendarTitle: item.title,
        calendarLocation: item.location,
    };
    saveTimedWakeSchedule(schedule);
    void import("./push-bailout-client").then(module => module.armTimedWakeBailout(schedule)).catch(() => undefined);
    return true;
}

export function cancelCalendarReminder(itemId: string): void {
    const ids = removeCalendarReminder(itemId);
    if (ids.length === 0) return;
    void import("./push-bailout-client").then(module => {
        for (const id of ids) module.cancelBailoutKey(`timedwake:${id}`);
    }).catch(() => undefined);
}
