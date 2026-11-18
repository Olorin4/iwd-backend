import { randomUUID } from "node:crypto";
import {
    applyFacetChange,
    lockRequest,
    receiptExists,
    recordReceipt,
} from "./store.js";
import { latestApprovedBundle, loadBundleFiles } from "./documents/bundles.js";
import { fillPacket, pageCount } from "./documents/pdf.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { continueUrl } from "./continueToken.js";
import { normalizeProviderStatus } from "./signature/errors.js";
import { verifySignwellEvent } from "./signature/signwell.js";
import { REQUESTER_NAME, packetMessages } from "./signature/messages.js";

// ERROR is not terminal: a verified re-fetch may show the provider did send the
// document (found in the 2026-11-18 sandbox run), and a DRAFT in ERROR is sent
// again on the same document id. Only provider-final states are terminal.
const TERMINAL = ["COMPLETED", "DECLINED", "EXPIRED", "CANCELLED"];
// SignWell can answer 422 to a send issued immediately after the upload while
// it is still processing the file (sandbox 2026-11-18). Retry the same send on
// the same document a few times before recording ERROR; never create another.
// Failure writes from a send attempt apply only while the envelope has not been
// confirmed sent; a concurrent successful send must never be downgraded.
const PRE_SEND = ["SENDING", "UNKNOWN", "ERROR"];
export const SEND_NOT_READY_DELAYS_MS = [2000, 5000, 10000];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendWithNotReadyRetry(deps, documentId) {
    const sleep = deps.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await deps.signature.send(documentId);
        } catch (error) {
            if (error?.status !== 422) throw error;
            // A 422 is either "still processing" (retry) or "not a draft any
            // more" (a concurrent send already succeeded). Decide from a
            // verified re-fetch, never from the 422 alone.
            let remote = null;
            try {
                remote = await deps.signature.get(documentId);
            } catch {
                throw error;
            }
            const state = normalizeProviderStatus(remote?.status);
            if (state && state !== "DRAFT") return { alreadySent: state };
            const delay = SEND_NOT_READY_DELAYS_MS[attempt];
            if (delay === undefined) throw error;
            log(deps, "onboarding_signature_send_not_ready", {
                attempt: attempt + 1,
            });
            await sleep(delay);
        }
    }
}
export const REISSUABLE = ["DECLINED", "EXPIRED", "CANCELLED", "ERROR"];
const STALE_SENDING_MS = 10 * 60 * 1000;

const activeEnvelope = (db, requestId) =>
    db.signatureEnvelope.findFirst({
        where: {
            request_id: requestId,
            superseded_by: null,
            state: { not: "ABANDONED" },
        },
    });

const log = (deps, code, extra = {}) => deps.logger?.info?.({ code, ...extra });

/**
 * Creates the request's envelope row (SENDING) inside a locked transaction.
 * With `supersede`, the current terminal envelope is superseded first
 * (reissue_packet). Returns the envelope, or null when nothing may be sent.
 */
async function claimEnvelope(deps, requestId, { supersede = false } = {}) {
    return deps.db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        if (!row || row.cancelled_at) return null;
        const current = await activeEnvelope(tx, requestId);
        if (current && !supersede) return null;
        if (supersede && (!current || !REISSUABLE.includes(current.state)))
            return null;
        const bundle = await latestApprovedBundle(tx, deps.config.bundleName);
        if (!bundle) {
            await applyFacetChange(
                tx,
                row,
                {
                    signature_state: "NOT_SENT",
                    signature_code: "bundle_unavailable",
                    signature_at: deps.now(),
                },
                deps.now()
            );
            return null;
        }
        const id = randomUUID();
        if (current)
            await tx.signatureEnvelope.update({
                where: { id: current.id },
                data: { superseded_by: id },
            });
        const envelope = await tx.signatureEnvelope.create({
            data: {
                id,
                request_id: requestId,
                provider: deps.signature.name,
                state: "SENDING",
            },
        });
        await applyFacetChange(
            tx,
            row,
            {
                signature_state: "SENDING",
                signature_code: null,
                signature_at: deps.now(),
                bundle_version_id: bundle.id,
            },
            deps.now()
        );
        return { envelope, bundle, row, superseded: current };
    });
}

/** Re-reads the request under its lock: true when it has been cancelled. */
const cancelledNow = (deps, requestId) =>
    deps.db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        return !row || !!row.cancelled_at;
    });

/** Best-effort withdrawal of a provider document; failures are logged by code. */
async function withdrawDocument(deps, documentId, failureCode) {
    try {
        await deps.signature.delete(documentId);
        return true;
    } catch (error) {
        deps.logger?.error?.({
            code: failureCode,
            reason: error?.code ?? "error",
        });
        return false;
    }
}

/**
 * The request was cancelled while a send was in flight: never send; withdraw
 * any created provider document and close the envelope.
 */
async function stopForCancel(deps, envelope) {
    if (envelope.provider_document_id)
        await withdrawDocument(
            deps,
            envelope.provider_document_id,
            "onboarding_cancel_withdraw_failed"
        );
    log(deps, "onboarding_signature_send_cancelled");
    return setEnvelopeState(
        deps,
        envelope.id,
        { state: "CANCELLED", onlyFrom: PRE_SEND },
        null
    );
}

/** Updates an envelope and, if it is the request's live envelope, the facet. */
async function setEnvelopeState(deps, envelopeId, envelopeUpdate, facet) {
    const { onlyFrom, ...envelopeData } = envelopeUpdate;
    return deps.db.$transaction(async (tx) => {
        const envelope = await tx.signatureEnvelope.findUnique({
            where: { id: envelopeId },
        });
        const row = await lockRequest(tx, envelope.request_id);
        const fresh = await tx.signatureEnvelope.findUnique({
            where: { id: envelopeId },
        });
        if (
            TERMINAL.includes(fresh.state) &&
            envelopeData.state &&
            envelopeData.state !== fresh.state
        )
            return { row, changed: false };
        // Compare-and-set under the request lock: a failure write only applies
        // over a pre-send state.
        if (onlyFrom && !onlyFrom.includes(fresh.state))
            return { row, changed: false };
        await tx.signatureEnvelope.update({
            where: { id: envelopeId },
            data: envelopeData,
        });
        if (!facet || fresh.superseded_by) return { row, changed: false };
        return applyFacetChange(tx, row, facet, deps.now());
    });
}

const abandon = (deps, envelopeId, code) =>
    setEnvelopeState(
        deps,
        envelopeId,
        { state: "ABANDONED", last_error_code: code },
        {
            signature_state: "NOT_SENT",
            signature_code: code,
            signature_at: deps.now(),
        }
    );

async function storeFilled(deps, filledFiles) {
    const manifest = [];
    for (const file of filledFiles) {
        const stored = await deps.documentStore.put(file.bytes);
        manifest.push({
            name: file.name,
            sha256: stored.sha256,
            size: stored.size,
            storage_key: stored.storage_key,
        });
    }
    const manifestBytes = Buffer.from(canonicalJson({ files: manifest }));
    const stored = await deps.documentStore.put(manifestBytes);
    return {
        filled_sha256: sha256Hex(manifestBytes),
        filled_storage_key: stored.storage_key,
    };
}

/** Total page count of the filled packet files stored for an envelope. */
async function filledPageCount(deps, envelope) {
    const manifest = JSON.parse(
        (
            await deps.documentStore.get(envelope.filled_storage_key, {
                expectedSha256: envelope.filled_sha256,
            })
        ).toString("utf8")
    );
    let total = 0;
    for (const file of manifest.files)
        total += await pageCount(
            await deps.documentStore.get(file.storage_key, {
                expectedSha256: file.sha256,
            })
        );
    return total;
}

/**
 * Outside test mode the completed PDF must carry the provider's audit page,
 * i.e. have more pages than the filled packet. (SignWell omits the audit page
 * in test mode, observed in the sandbox, so the check is skipped there.)
 */
async function hasAuditPage(deps, envelope, pdf) {
    if (deps.config.signature?.testMode) return true;
    try {
        return (await pageCount(pdf)) > (await filledPageCount(deps, envelope));
    } catch (error) {
        log(deps, "onboarding_audit_page_check_failed", {
            reason: error?.code ?? "error",
        });
        return false;
    }
}

/** Send a draft that already exists at the provider (same document id). */
async function sendExisting(deps, envelope) {
    if (await cancelledNow(deps, envelope.request_id))
        return stopForCancel(deps, envelope);
    let result;
    try {
        result = await sendWithNotReadyRetry(
            deps,
            envelope.provider_document_id
        );
    } catch (error) {
        if (error.ambiguous) {
            log(deps, "onboarding_signature_send_unknown");
            return setEnvelopeState(
                deps,
                envelope.id,
                {
                    state: "UNKNOWN",
                    last_error_code: error.code,
                    onlyFrom: PRE_SEND,
                },
                {
                    signature_state: "UNKNOWN",
                    signature_code: "send_outcome_unknown",
                    signature_at: deps.now(),
                }
            );
        }
        return setEnvelopeState(
            deps,
            envelope.id,
            {
                state: "ERROR",
                last_error_code: error.code ?? "send_failed",
                onlyFrom: PRE_SEND,
            },
            {
                signature_state: "ERROR",
                signature_code: "send_rejected",
                signature_at: deps.now(),
            }
        );
    }
    // Someone else's send already went through: follow the verified remote state.
    if (result?.alreadySent) return reconcileEnvelope(deps, envelope.id);
    // Compare-and-set: a concurrent reconcile may already have seen VIEWED or
    // COMPLETED; the success write never downgrades it.
    return setEnvelopeState(
        deps,
        envelope.id,
        {
            state: "SENT",
            sent_at: deps.now(),
            last_error_code: null,
            onlyFrom: PRE_SEND,
        },
        {
            signature_state: "SENT",
            signature_code: null,
            signature_at: deps.now(),
        }
    );
}

async function deliverEnvelope(deps, { envelope, bundle, row }) {
    let filled;
    try {
        const files = await loadBundleFiles(deps.documentStore, bundle);
        filled = await fillPacket(
            files,
            bundle.layout,
            row.terms,
            deps.config.signature.countersigner
        );
    } catch (error) {
        log(deps, "onboarding_packet_fill_failed", {
            reason: error?.code ?? "error",
        });
        return abandon(deps, envelope.id, "packet_fill_failed");
    }
    const hashes = await storeFilled(deps, filled);
    await deps.db.signatureEnvelope.update({
        where: { id: envelope.id },
        data: hashes,
    });

    const terms = row.terms;
    const copy = packetMessages(terms, { requestId: row.id });
    // Signing order (owner ruling 2026-11-18): Iron Wing signs first, so its
    // review happens before the carrier sees the packet; the carrier signs last
    // and SignWell's redirect then takes the carrier to the payment step.
    // SignWell signs in the order of this array; ids keep the layout's roles
    // (recipient 1 = Carrier fields, recipient 2 = Dispatch fields).
    const signers = [
        {
            id: "2",
            role: "Dispatch",
            name: deps.config.signature.countersigner.name,
            email: deps.config.signature.countersigner.email,
            ...copy.dispatch,
        },
        {
            id: "1",
            role: "Carrier",
            name: terms.signer.name,
            email: terms.signer.email,
            ...copy.carrier,
        },
    ];
    if (await cancelledNow(deps, row.id)) return stopForCancel(deps, envelope);
    let created;
    try {
        created = await deps.signature.createEnvelope(
            { files: filled },
            signers,
            {
                onboarding_request_id: row.id,
                envelope_id: envelope.id,
                name: copy.name,
                subject: copy.carrier.subject,
                message: copy.carrier.message,
                requester_name: REQUESTER_NAME,
                requester_email: deps.config.signature.requesterEmail ?? null,
                // The carrier signs last, so this redirect reaches the carrier;
                // the dispatcher passing through it sees a neutral waiting page.
                redirect_url: continueUrl(deps.config, row.id, deps.now()),
            }
        );
    } catch (error) {
        // A draft cannot email anyone; an orphan draft is deleted when its
        // document_created webhook arrives (metadata names this envelope).
        log(deps, "onboarding_signature_create_failed", {
            reason: error?.code ?? "error",
        });
        return abandon(deps, envelope.id, "packet_create_failed");
    }
    const withId = await deps.db.signatureEnvelope.update({
        where: { id: envelope.id },
        data: { provider_document_id: created.id },
    });
    return sendExisting(deps, withId);
}

/** Sends the packet for a new request. Never sends twice for one request. */
export async function sendPacket(deps, requestId) {
    const claim = await claimEnvelope(deps, requestId);
    if (!claim) return null;
    return deliverEnvelope(deps, claim);
}

/** Supersedes a declined/expired/cancelled/error envelope with a new one. */
export async function reissuePacket(deps, requestId) {
    const claim = await claimEnvelope(deps, requestId, { supersede: true });
    if (!claim) return null;
    // A superseded envelope that is not provider-final (e.g. ERROR) may still
    // be live at the provider: withdraw it so the signer never holds two.
    const old = claim.superseded;
    if (old?.provider_document_id && !TERMINAL.includes(old.state)) {
        const withdrawn = await withdrawDocument(
            deps,
            old.provider_document_id,
            "onboarding_reissue_withdraw_failed"
        );
        if (withdrawn)
            await deps.db.signatureEnvelope.update({
                where: { id: old.id },
                data: { state: "CANCELLED" },
            });
    }
    return deliverEnvelope(deps, claim);
}

/**
 * Re-fetches the provider document and applies its state. The provider is
 * the source of truth; webhooks only trigger this.
 */
export async function reconcileEnvelope(deps, envelopeId) {
    const envelope = await deps.db.signatureEnvelope.findUnique({
        where: { id: envelopeId },
    });
    if (!envelope || envelope.state === "ABANDONED") return null;
    if (!envelope.provider_document_id) {
        if (
            envelope.state === "SENDING" &&
            deps.now() - envelope.created_at > STALE_SENDING_MS
        )
            return abandon(deps, envelope.id, "packet_create_failed");
        return null;
    }
    if (["DECLINED", "EXPIRED", "CANCELLED"].includes(envelope.state))
        return null;
    if (envelope.state === "COMPLETED" && envelope.completed_storage_key)
        return null;

    let remote;
    try {
        remote = await deps.signature.get(envelope.provider_document_id);
    } catch (error) {
        log(deps, "onboarding_signature_reconcile_failed", {
            reason: error?.code ?? "error",
        });
        return null;
    }
    const state = normalizeProviderStatus(remote.status);
    const now = deps.now();
    if (state === "DRAFT") {
        if (
            ["UNKNOWN", "SENDING", "ERROR"].includes(envelope.state) &&
            !envelope.superseded_by
        )
            return sendExisting(deps, envelope);
        return null;
    }
    if (state === "SENT" || state === "VIEWED") {
        if (
            envelope.state === state ||
            (envelope.state === "VIEWED" && state === "SENT")
        )
            return null;
        return setEnvelopeState(
            deps,
            envelope.id,
            { state, sent_at: envelope.sent_at ?? now, last_error_code: null },
            { signature_state: state, signature_code: null, signature_at: now }
        );
    }
    if (state === "COMPLETED") {
        let pdf;
        try {
            pdf = await deps.signature.downloadCompleted(
                envelope.provider_document_id
            );
        } catch (error) {
            log(deps, "onboarding_completed_download_failed", {
                reason: error?.code ?? "error",
            });
            return null;
        }
        if (!(await hasAuditPage(deps, envelope, pdf))) {
            // Keep the envelope open (polled again); block with reconcile.
            deps.logger?.error?.({ code: "onboarding_audit_page_missing" });
            const open = envelope.state === "VIEWED" ? "VIEWED" : "SENT";
            return setEnvelopeState(
                deps,
                envelope.id,
                {
                    state: open,
                    sent_at: envelope.sent_at ?? now,
                    last_error_code: "audit_page_missing",
                },
                {
                    signature_state: open,
                    signature_code: "audit_page_missing",
                    signature_at: now,
                }
            );
        }
        const stored = await deps.documentStore.put(pdf);
        const result = await setEnvelopeState(
            deps,
            envelope.id,
            {
                state: "COMPLETED",
                completed_at: now,
                completed_sha256: stored.sha256,
                completed_storage_key: stored.storage_key,
            },
            {
                signature_state: "COMPLETED",
                signature_code: null,
                signature_at: now,
            }
        );
        if (result.changed)
            deps.schedule(() => deps.onSignatureCompleted(envelope.request_id));
        return result;
    }
    if (["DECLINED", "EXPIRED", "CANCELLED", "ERROR"].includes(state)) {
        const stamps =
            { DECLINED: { declined_at: now }, EXPIRED: { expired_at: now } }[
                state
            ] ?? {};
        return setEnvelopeState(
            deps,
            envelope.id,
            { state, ...stamps },
            {
                signature_state: state,
                signature_code:
                    state === "ERROR" ? "provider_document_error" : null,
                signature_at: now,
            }
        );
    }
    log(deps, "onboarding_signature_status_unrecognized");
    return null;
}

/** Signature facet recovery for the `reconcile` action and the job. */
export async function reconcileSignature(deps, requestId) {
    const row = await deps.db.onboardingRequest.findUnique({
        where: { id: requestId },
    });
    if (!row || row.cancelled_at) return null;
    const envelope = await activeEnvelope(deps.db, requestId);
    if (!envelope)
        return row.signature_state === "NOT_SENT"
            ? sendPacket(deps, requestId)
            : null;
    return reconcileEnvelope(deps, envelope.id);
}

export const SIGNWELL_EVENT_MAX_SKEW_MS = 10 * 60 * 1000;
export const WEBHOOK_REFETCH_INTERVAL_MS = 30 * 1000;
const WEBHOOK_OPEN_STATES = ["SENDING", "UNKNOWN", "SENT", "VIEWED", "ERROR"];

/**
 * POST /onboarding/webhooks/signwell. Returns an HTTP status.
 *
 * SignWell's hash covers only "type@time", so a captured event could be
 * replayed with any document id. The event is therefore only a hint, bounded:
 * - events more than 10 minutes from now are ignored (`stale_event`); the
 *   reconcile poller covers legitimately late deliveries;
 * - nothing is fetched unless the id is one of our own open envelopes;
 * - receipts dedupe the signed tuple plus the document id;
 * - webhooks re-fetch one envelope at most once per 30 seconds.
 * Ignored events get 202 so the provider does not retry them.
 */
export async function handleSignwellWebhook(deps, body) {
    const verified = verifySignwellEvent(body, deps.config.signature.webhookId);
    if (!verified) return 401;
    const { type, time, expected } = verified;
    const now = deps.now();
    const timeMs = Number(time) * 1000;
    if (
        !Number.isFinite(timeMs) ||
        Math.abs(now.getTime() - timeMs) > SIGNWELL_EVENT_MAX_SKEW_MS
    ) {
        log(deps, "stale_event");
        return 202;
    }
    const documentId = body.data?.object?.id;
    if (typeof documentId !== "string" || documentId.length > 200) return 202;

    const envelope = await deps.db.signatureEnvelope.findUnique({
        where: { provider_document_id: documentId },
    });
    const open =
        envelope &&
        !envelope.superseded_by &&
        (WEBHOOK_OPEN_STATES.includes(envelope.state) ||
            (envelope.state === "COMPLETED" &&
                !envelope.completed_storage_key));
    if (!open) {
        log(deps, "onboarding_signwell_event_ignored");
        return 202;
    }
    const receiptKey = `${type}:${time}:${expected}:${documentId}`;
    if (await receiptExists(deps.db, "signwell", receiptKey)) return 200;
    // Throttle first: a throttled event must not consume its receipt, so the
    // provider's redelivery of it is still processed.
    const { count } = await deps.db.signatureEnvelope.updateMany({
        where: {
            id: envelope.id,
            OR: [
                { last_webhook_fetch_at: null },
                {
                    last_webhook_fetch_at: {
                        lt: new Date(
                            now.getTime() - WEBHOOK_REFETCH_INTERVAL_MS
                        ),
                    },
                },
            ],
        },
        data: { last_webhook_fetch_at: now },
    });
    if (count !== 1) {
        log(deps, "onboarding_signwell_event_throttled");
        return 202;
    }
    if (!(await recordReceipt(deps.db, "signwell", receiptKey))) return 200;
    await reconcileEnvelope(deps, envelope.id);
    return 200;
}

/** Envelopes the reconcile job polls. */
export async function openEnvelopeIds(db, now) {
    const rows = await db.signatureEnvelope.findMany({
        where: {
            superseded_by: null,
            OR: [
                { state: { in: ["UNKNOWN", "SENT", "VIEWED"] } },
                {
                    state: "SENDING",
                    created_at: { lt: new Date(now - STALE_SENDING_MS) },
                },
                { state: "COMPLETED", completed_storage_key: null },
            ],
        },
        select: { id: true },
        take: 200,
    });
    return rows.map((r) => r.id);
}
