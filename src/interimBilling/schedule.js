// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
//
// Time-zone arithmetic for the weekly run, with no dependency: the run end
// (a local Monday 00:00 as a UTC instant), business days with US federal
// holidays, and "is it Friday after the run hour".

// 2026 and 2027, including observed dates when a holiday falls on a weekend.
export const US_FEDERAL_HOLIDAYS = new Set([
    // 2026
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-10-12",
    "2026-11-11",
    "2026-11-26",
    "2026-12-25",
    // 2027
    "2027-01-01",
    "2027-01-18",
    "2027-02-15",
    "2027-05-31",
    "2027-06-18",
    "2027-07-05",
    "2027-09-06",
    "2027-10-11",
    "2027-11-11",
    "2027-11-25",
    "2027-12-24",
    "2027-12-31",
]);

const WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** The local calendar and clock parts of an instant in a time zone. */
function localParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        weekday: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type).value;
    return {
        year: Number(get("year")),
        month: Number(get("month")),
        day: Number(get("day")),
        hour: Number(get("hour")),
        minute: Number(get("minute")),
        second: Number(get("second")),
        weekday: WEEKDAYS[get("weekday")], // Monday = 0
    };
}

/** Local time minus UTC, in milliseconds, at an instant. */
function offsetMs(date, timeZone) {
    const p = localParts(date, timeZone);
    const asUtc = Date.UTC(
        p.year,
        p.month - 1,
        p.day,
        p.hour,
        p.minute,
        p.second
    );
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of a local wall-clock time in a time zone. */
function instantOf(year, month, day, hour, minute, second, timeZone) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, second);
    const first = offsetMs(new Date(guess), timeZone);
    let instant = guess - first;
    const second2 = offsetMs(new Date(instant), timeZone);
    if (second2 !== first) instant = guess - second2;
    return new Date(instant);
}

const pad = (n) => String(n).padStart(2, "0");

function isBusinessDay(year, month, day) {
    const weekday =
        (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
    if (weekday >= 5) return false;
    return !US_FEDERAL_HOLIDAYS.has(`${year}-${pad(month)}-${pad(day)}`);
}

/** The latest Monday 00:00 (local) at or before `now`, as a UTC instant. */
export function runEndUtc(now, timeZone) {
    const p = localParts(now, timeZone);
    const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - p.weekday));
    return instantOf(
        monday.getUTCFullYear(),
        monday.getUTCMonth() + 1,
        monday.getUTCDate(),
        0,
        0,
        0,
        timeZone
    );
}

/**
 * `days` business days after `from`, keeping the local clock time. Weekends
 * and US federal holidays are skipped.
 */
export function addBusinessDays(from, days, timeZone) {
    if (days === 0) return new Date(from.getTime());
    const p = localParts(from, timeZone);
    const cursor = new Date(Date.UTC(p.year, p.month - 1, p.day));
    let remaining = days;
    while (remaining > 0) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        if (
            isBusinessDay(
                cursor.getUTCFullYear(),
                cursor.getUTCMonth() + 1,
                cursor.getUTCDate()
            )
        ) {
            remaining -= 1;
        }
    }
    return instantOf(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
        cursor.getUTCDate(),
        p.hour,
        p.minute,
        p.second,
        timeZone
    );
}

/** True on a local Friday at or after `runHour`. */
export function isRunDue(now, timeZone, runHour) {
    const p = localParts(now, timeZone);
    return p.weekday === 4 && p.hour >= runHour;
}
