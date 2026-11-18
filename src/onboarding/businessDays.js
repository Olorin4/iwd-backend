// Business days for R15 reminders: Monday–Friday in America/New_York (no
// holiday calendar). Pure; no I/O.

export const BUSINESS_TIME_ZONE = "America/New_York";

const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});

/** Wall-clock fields of an instant in New York. */
function zonedParts(date) {
    const out = {};
    for (const { type, value } of formatter.formatToParts(date))
        if (type !== "literal") out[type] = Number(value);
    return {
        year: out.year,
        month: out.month,
        day: out.day,
        hour: out.hour,
        minute: out.minute,
        second: out.second,
        ms: date.getUTCMilliseconds(),
    };
}

const asUtc = (p) =>
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);

/** The instant at which New York's wall clock shows `p` (DST-aware). */
function zonedToInstant(p) {
    let t = asUtc(p);
    for (let i = 0; i < 3; i += 1) {
        const shift = asUtc(p) - asUtc(zonedParts(new Date(t)));
        if (shift === 0) break;
        t += shift;
    }
    return new Date(t);
}

/**
 * `start` plus `n` business days: the same New York wall-clock time on the
 * n-th Monday–Friday after start's New York date. A weekend start counts
 * from the following Monday (Saturday + 1 = Monday).
 */
export function addBusinessDays(start, n) {
    const begin = new Date(start);
    if (!Number.isInteger(n) || n < 0) throw new Error("invalid_business_days");
    if (n === 0) return begin;
    const p = zonedParts(begin);
    let day = Date.UTC(p.year, p.month - 1, p.day);
    for (let added = 0; added < n; ) {
        day += 86400000;
        const weekday = new Date(day).getUTCDay();
        if (weekday !== 0 && weekday !== 6) added += 1;
    }
    const date = new Date(day);
    return zonedToInstant({
        ...p,
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
    });
}

/** R15: reminder 1 after 3 business days, reminder 2 after 7. */
export const REMINDER_BUSINESS_DAYS = [3, 7];

/** When reminder `number` (1 or 2) is due, or null when there is none. */
export function reminderDueAt(documentsRequestedAt, number) {
    const days = REMINDER_BUSINESS_DAYS[number - 1];
    if (!documentsRequestedAt || days === undefined) return null;
    return addBusinessDays(documentsRequestedAt, days);
}
