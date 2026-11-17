// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
//
// Money is integer cents and fees are integer basis points. No floating
// point is used to calculate an amount.

export const MIN_CHARGE_CENTS = 50;

/**
 * Parses a plain amount ("2400.00", "12.5", 7) into integer cents. Returns
 * null for a missing value; throws for anything else that is not a
 * non-negative amount with at most two decimals.
 */
export function toCents(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Amount is not a finite number.");
    }
    const text = String(value);
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!match)
        throw new Error(
            "Amount is not a plain amount with at most two decimals."
        );
    const dollars = Number(match[1]);
    const cents = Number((match[2] || "").padEnd(2, "0") || "0");
    const total = dollars * 100 + cents;
    if (!Number.isSafeInteger(total)) throw new Error("Amount is too large.");
    return total;
}

/** linehaulCents x basisPoints / 10,000, rounded half up, in integers. */
export function feeCents(linehaulCents, basisPoints) {
    return Math.floor((linehaulCents * basisPoints * 2 + 10000) / 20000);
}

/** 240000 -> "$2,400.00" */
export function formatUsd(cents) {
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(cents);
    const dollars = Math.trunc(abs / 100).toLocaleString("en-US");
    const rest = String(abs % 100).padStart(2, "0");
    return `${sign}$${dollars}.${rest}`;
}

function shortDate(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get("weekday")} ${get("month")} ${get("day")}`;
}

/**
 * The text of one invoice line, built only from numbers and dates so no
 * carrier-supplied text can reach it.
 */
export function describeLine(
    {
        kind,
        loadNumber,
        kelevoLoadId,
        occurredAt,
        linehaulCents,
        feeBp,
        feeCents: fee,
    },
    timeZone
) {
    const load = loadNumber ?? `id ${kelevoLoadId}`;
    const verb = kind === "CARRIER_CANCELLED" ? "cancelled" : "delivered";
    return `Load ${load}, ${verb} ${shortDate(occurredAt, timeZone)}: linehaul ${formatUsd(linehaulCents)} x ${feeBp / 100}% = ${formatUsd(fee)}`;
}
