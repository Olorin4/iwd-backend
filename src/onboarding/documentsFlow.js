import { transition } from "./store.js";
import { continueUrl } from "./continueToken.js";
import { agreementFilename, completionEmail } from "./emails.js";

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
