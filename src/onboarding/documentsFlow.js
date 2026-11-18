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

/**
 * Sends the combined completion email exactly once per request. The claim
 * (`completion_emailed_at`) is taken atomically, only while the signature is
 * COMPLETED and the request is not cancelled; webhook, reconcile and recovery
 * may all call this concurrently. A missing/corrupt document or a send failure
 * releases the claim, so the reconcile pass retries. A process stop between
 * the claim and the send leaves the claim set (never a duplicate email).
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
        },
        data: { completion_emailed_at: now },
    });
    if (count !== 1) return false;
    const release = async (code, reason) => {
        await db.onboardingRequest.updateMany({
            where: { id: requestId, documents_requested_at: null },
            data: { completion_emailed_at: null },
        });
        logError(deps, code, reason);
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
        data: { emailed_at: now },
    });
    await transition(
        db,
        row.id,
        (r) =>
            r.documents_requested_at ? null : { documents_requested_at: now },
        { now: () => now }
    );
    return true;
}

/** True once the combined email has been claimed or sent for the request. */
export async function completionEmailClaimed(db, requestId) {
    const row = await db.onboardingRequest.findUnique({
        where: { id: requestId },
        select: { completion_emailed_at: true },
    });
    return !!row?.completion_emailed_at;
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

/** Candidates for the reminder sweep (due-ness is checked under the lock). */
export async function reminderCandidateIds(deps) {
    const rows = await deps.db.onboardingRequest.findMany({
        where: {
            cancelled_at: null,
            reminders_paused: false,
            reminders_sent: { lt: MAX_REMINDERS },
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
 * Sends the next reminder for a request when it is due. The reminder number
 * is claimed under the request lock (reminders_sent n-1 → n, a status event),
 * so each number goes out at most once; a send failure gives the number back
 * and the next pass retries. Returns true when this call sent one.
 */
export async function sendDueReminder(deps, requestId) {
    const { db } = deps;
    const now = deps.now();
    let claim = null;
    await transition(
        db,
        requestId,
        (row) => {
            claim = reminderDue(row, now);
            if (claim) claim.row = row;
            return claim ? { reminders_sent: claim.number } : null;
        },
        { now: () => now }
    );
    if (!claim) return false;
    const { row, number, missing, paymentMissing } = claim;
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
        await transition(
            db,
            requestId,
            (r) =>
                r.reminders_sent === number
                    ? { reminders_sent: number - 1 }
                    : null,
            { now: () => deps.now() }
        );
        logError(deps, "onboarding_reminder_email_failed");
        return false;
    }
    deps.logger?.info?.({ code: "onboarding_reminder_emailed", number });
    return true;
}
