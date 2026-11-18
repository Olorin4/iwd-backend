import { transition } from "./store.js";
import { continueUrl } from "./continueToken.js";
import { agreementFilename, completionEmail, reminderEmail } from "./emails.js";
import { missingCarrierSlots } from "./readiness.js";
import { REMINDER_BUSINESS_DAYS, reminderDueAt } from "./businessDays.js";

// R15: the combined completion email (signed copy + payment link + documents
// list). It replaces the separate payment-link email.

const logInfo = (deps, code) => deps.logger?.info?.({ code });
const logError = (deps, code, reason) =>
    deps.logger?.error?.({ code, ...(reason ? { reason } : {}) });

/** Reply-to for carrier emails: ONBOARDING_REQUESTER_EMAIL when set. */
export const replyToOf = (config) =>
    config.signature?.requesterEmail
        ? { replyTo: config.signature.requesterEmail }
        : {};

/** The request's stored completed packet (sha256-checked), or null. */
async function completedPacket(deps, requestId) {
    const envelope = await deps.db.signatureEnvelope.findFirst({
        where: {
            request_id: requestId,
            state: "COMPLETED",
            completed_storage_key: { not: null },
        },
        orderBy: { completed_at: "desc" },
    });
    if (!envelope) return null;
    const bytes = await deps.documentStore.get(envelope.completed_storage_key, {
        expectedSha256: envelope.completed_sha256,
    });
    return { envelope, bytes };
}

/** A claim older than this is presumed dead (process stopped) and re-claimed. */
export const STALE_EMAIL_CLAIM_MS = 30 * 60 * 1000;
/** Attempts per email (completion email; each reminder number). */
export const MAX_EMAIL_ATTEMPTS = 3;
export const COMPLETION_EMAIL_FAILED = "completion_email_failed";

const staleBefore = (now) => new Date(now.getTime() - STALE_EMAIL_CLAIM_MS);
const claimFree = (now, field) => ({
    OR: [{ [field]: null }, { [field]: { lt: staleBefore(now) } }],
});

/**
 * After the last attempt failed or went stale: log and surface BLOCKED
 * `completion_email_failed` (action `reconcile`) once.
 */
async function flagCompletionStuck(deps, requestId, now) {
    const result = await transition(
        deps.db,
        requestId,
        (r) =>
            !r.cancelled_at &&
            !r.completion_emailed_at &&
            !r.completion_email_code &&
            r.completion_email_attempts >= MAX_EMAIL_ATTEMPTS &&
            (!r.completion_email_claimed_at ||
                r.completion_email_claimed_at < staleBefore(now))
                ? { completion_email_code: COMPLETION_EMAIL_FAILED }
                : null,
        { now: () => now }
    );
    if (result.changed) logError(deps, "onboarding_completion_email_stuck");
    return result.changed;
}

/**
 * Sends the combined completion email once per request. State: a claim
 * (`completion_email_claimed_at`, taken atomically while the signature is
 * COMPLETED, the request not cancelled and fewer than 3 attempts were made)
 * and the sent mark (`completion_emailed_at`, set only after SMTP accepted).
 * Webhook, reconcile and recovery may all call this concurrently. A missing or
 * corrupt document or an SMTP failure releases the claim (the next pass
 * retries); a claim left by a stopped process is re-claimed after 30 minutes.
 * After 3 attempts the request is BLOCKED `completion_email_failed`; the
 * `reconcile` action allows 3 more. A stop after SMTP accepted but before the
 * sent mark can cause one duplicate email (accepted by design).
 * Returns true when this call sent the email.
 */
export async function sendCompletionEmail(deps, requestId) {
    const { db } = deps;
    const now = deps.now();
    const { count } = await db.onboardingRequest.updateMany({
        where: {
            id: requestId,
            completion_emailed_at: null,
            cancelled_at: null,
            signature_state: "COMPLETED",
            completion_email_attempts: { lt: MAX_EMAIL_ATTEMPTS },
            ...claimFree(now, "completion_email_claimed_at"),
        },
        data: {
            completion_email_claimed_at: now,
            completion_email_attempts: { increment: 1 },
        },
    });
    if (count !== 1) {
        await flagCompletionStuck(deps, requestId, now);
        return false;
    }
    const release = async (code, reason) => {
        await db.onboardingRequest.updateMany({
            where: {
                id: requestId,
                completion_emailed_at: null,
                completion_email_claimed_at: now,
            },
            data: { completion_email_claimed_at: null },
        });
        logError(deps, code, reason);
        await flagCompletionStuck(deps, requestId, now);
        return false;
    };

    const row = await db.onboardingRequest.findUnique({
        where: { id: requestId },
    });
    let packet;
    try {
        packet = await completedPacket(deps, requestId);
    } catch (error) {
        return release(
            "onboarding_completion_document_unavailable",
            error?.code ?? "error"
        );
    }
    if (!packet) return release("onboarding_completion_document_missing");

    const { subject, text } = completionEmail({
        terms: row.terms,
        requestId: row.id,
        url: continueUrl(deps.config, row.id, now),
    });
    try {
        await deps.sendEmail({
            from: deps.config.email.from,
            to: row.terms.recipient_email,
            ...replyToOf(deps.config),
            subject,
            text,
            attachments: [
                {
                    filename: agreementFilename(row.terms.legal_name),
                    content: packet.bytes,
                    contentType: "application/pdf",
                },
            ],
        });
    } catch {
        return release("onboarding_completion_email_failed");
    }
    const sentAt = deps.now();
    await db.onboardingRequest.updateMany({
        where: { id: requestId, completion_emailed_at: null },
        data: { completion_emailed_at: sentAt },
    });
    logInfo(deps, "onboarding_completion_emailed");

    await db.documentAccessLog.create({
        data: {
            request_id: row.id,
            actor: { system: "completion_email" },
            document: `signed_packet_email:${packet.envelope.id}`,
        },
    });
    // The combined email is the payment-link email: open setups count as
    // emailed, so the payment reconcile never sends another.
    await db.paymentSetup.updateMany({
        where: {
            request_id: row.id,
            emailed_at: null,
            state: { in: ["CREATING", "OPEN"] },
        },
        data: { emailed_at: sentAt },
    });
    await transition(
        db,
        row.id,
        (r) => ({
            documents_requested_at: r.documents_requested_at ?? sentAt,
            completion_email_code: null,
        }),
        { now: () => sentAt }
    );
    return true;
}

/**
 * The `reconcile` action on a request BLOCKED `completion_email_failed`:
 * allows another 3 attempts (the action then runs the recovery send).
 */
export async function resetStuckCompletionEmail(deps, requestId) {
    const { count } = await deps.db.onboardingRequest.updateMany({
        where: {
            id: requestId,
            completion_emailed_at: null,
            completion_email_code: COMPLETION_EMAIL_FAILED,
        },
        data: {
            completion_email_attempts: 0,
            completion_email_claimed_at: null,
        },
    });
    return count === 1;
}

/** True once the combined email has been claimed or sent for the request. */
export async function completionEmailClaimed(db, requestId) {
    const row = await db.onboardingRequest.findUnique({
        where: { id: requestId },
        select: {
            completion_emailed_at: true,
            completion_email_claimed_at: true,
        },
    });
    return !!(row?.completion_emailed_at || row?.completion_email_claimed_at);
}

// ---------------------------------------------------------------------------
// R15 documents reminders: at most two, 3 and 7 business days (Mon–Fri,
// America/New_York) after the completion email, only while a carrier-facing
// document is PENDING or the payment method is not saved. Never after cancel
// or while paused. Run by the reconcile worker pass only.

export const MAX_REMINDERS = REMINDER_BUSINESS_DAYS.length;
const PAYMENT_SAVED = ["READY", "PENDING_VERIFICATION"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a reminder for this row would contain, or null when none is due. */
function reminderDue(row, now) {
    if (
        row.cancelled_at ||
        row.reminders_paused ||
        !row.documents_requested_at ||
        row.reminders_sent >= MAX_REMINDERS
    )
        return null;
    const number = row.reminders_sent + 1;
    if (now < reminderDueAt(row.documents_requested_at, number)) return null;
    const missing = missingCarrierSlots(row.operations);
    const paymentMissing = !PAYMENT_SAVED.includes(row.payment_state);
    if (missing.length === 0 && !paymentMissing) return null;
    return { number, missing, paymentMissing };
}

/** Candidates for the reminder sweep (due-ness is re-checked on claim). */
export async function reminderCandidateIds(deps) {
    const rows = await deps.db.onboardingRequest.findMany({
        where: {
            cancelled_at: null,
            reminders_paused: false,
            reminders_sent: { lt: MAX_REMINDERS },
            // Exhausted numbers stay listed only while a claim is left over,
            // so the stuck log is written once.
            OR: [
                { reminder_attempts: { lt: MAX_EMAIL_ATTEMPTS } },
                { reminder_claimed_at: { not: null } },
            ],
            // Business days are never shorter than calendar days.
            documents_requested_at: {
                lte: new Date(
                    deps.now().getTime() - REMINDER_BUSINESS_DAYS[0] * DAY_MS
                ),
            },
        },
        select: { id: true },
        take: 200,
    });
    return rows.map((r) => r.id);
}

/**
 * Sends the next reminder for a request when it is due. State per number: a
 * claim (`reminder_claimed_at`, taken atomically against the current
 * `reminders_sent`; at most 3 attempts) and the sent count `reminders_sent`
 * (bumped only after SMTP accepted; status event). A send failure releases
 * the claim (the next pass retries); a claim left by a stopped process is
 * re-claimed after 30 minutes. After 3 attempts reminders stop for the
 * request (`onboarding_reminder_email_stuck`, logged once). A
 * stop after SMTP accepted but before the count is bumped can cause one
 * duplicate (accepted by design). Returns true when this call sent one.
 */
export async function sendDueReminder(deps, requestId) {
    const { db } = deps;
    const now = deps.now();
    const row = await db.onboardingRequest.findUnique({
        where: { id: requestId },
    });
    if (!row) return false;
    if (
        row.reminder_attempts >= MAX_EMAIL_ATTEMPTS &&
        row.reminder_claimed_at &&
        row.reminder_claimed_at < staleBefore(now)
    ) {
        const { count } = await db.onboardingRequest.updateMany({
            where: {
                id: requestId,
                reminder_claimed_at: row.reminder_claimed_at,
            },
            data: { reminder_claimed_at: null },
        });
        if (count === 1) logError(deps, "onboarding_reminder_email_stuck");
        return false;
    }
    const due = reminderDue(row, now);
    if (!due) return false;
    const { number, missing, paymentMissing } = due;
    const { count } = await db.onboardingRequest.updateMany({
        where: {
            id: requestId,
            cancelled_at: null,
            reminders_paused: false,
            reminders_sent: row.reminders_sent,
            reminder_attempts: { lt: MAX_EMAIL_ATTEMPTS },
            ...claimFree(now, "reminder_claimed_at"),
        },
        data: {
            reminder_claimed_at: now,
            reminder_attempts: { increment: 1 },
        },
    });
    if (count !== 1) return false;
    const { subject, text } = reminderEmail({
        terms: row.terms,
        requestId: row.id,
        missingSlots: missing,
        paymentUrl: paymentMissing
            ? continueUrl(deps.config, row.id, now)
            : null,
    });
    try {
        await deps.sendEmail({
            from: deps.config.email.from,
            to: row.terms.recipient_email,
            ...replyToOf(deps.config),
            subject,
            text,
        });
    } catch {
        const exhausted = row.reminder_attempts + 1 >= MAX_EMAIL_ATTEMPTS;
        await db.onboardingRequest.updateMany({
            where: { id: requestId, reminder_claimed_at: now },
            data: { reminder_claimed_at: null },
        });
        logError(deps, "onboarding_reminder_email_failed");
        if (exhausted) logError(deps, "onboarding_reminder_email_stuck");
        return false;
    }
    const sentAt = deps.now();
    await transition(
        db,
        requestId,
        (r) =>
            r.reminders_sent === number - 1 ? { reminders_sent: number } : null,
        { now: () => sentAt }
    );
    // The next number starts with a fresh claim and attempt count.
    await db.onboardingRequest.updateMany({
        where: { id: requestId, reminders_sent: number },
        data: { reminder_claimed_at: null, reminder_attempts: 0 },
    });
    deps.logger?.info?.({ code: "onboarding_reminder_emailed", number });
    return true;
}
