import { randomUUID } from "node:crypto";
import {
    applyFacetChange,
    lockRequest,
    receiptExists,
    recordReceipt,
} from "./store.js";
import { latestApprovedBundle, loadBundleFiles } from "./documents/bundles.js";
import { fillPacket } from "./documents/pdf.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { continueUrl } from "./continueToken.js";
import { normalizeProviderStatus } from "./signature/errors.js";
import { verifySignwellEvent } from "./signature/signwell.js";

const TERMINAL = ["COMPLETED", "DECLINED", "EXPIRED", "CANCELLED", "ERROR"];
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
        return { envelope, bundle, row };
    });
}

/** Updates an envelope and, if it is the request's live envelope, the facet. */
async function setEnvelopeState(deps, envelopeId, envelopeData, facet) {
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

/** Send a draft that already exists at the provider (same document id). */
async function sendExisting(deps, envelope) {
    try {
        await deps.signature.send(envelope.provider_document_id);
    } catch (error) {
        if (error.ambiguous) {
            log(deps, "onboarding_signature_send_unknown");
            return setEnvelopeState(
                deps,
                envelope.id,
                { state: "UNKNOWN", last_error_code: error.code },
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
            { state: "ERROR", last_error_code: error.code ?? "send_failed" },
            {
                signature_state: "ERROR",
                signature_code: "send_rejected",
                signature_at: deps.now(),
            }
        );
    }
    return setEnvelopeState(
        deps,
        envelope.id,
        { state: "SENT", sent_at: deps.now(), last_error_code: null },
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
        filled = await fillPacket(files, bundle.layout, row.terms);
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
    const signers = [
        {
            id: "1",
            role: "Carrier",
            name: terms.signer.name,
            email: terms.signer.email,
        },
        { id: "2", role: "Dispatch", ...deps.config.signature.countersigner },
    ];
    let created;
    try {
        created = await deps.signature.createEnvelope(
            { files: filled },
            signers,
            {
                onboarding_request_id: row.id,
                envelope_id: envelope.id,
                name: `Iron Wing Dispatching agreement - ${terms.legal_name}`.slice(
                    0,
                    200
                ),
                subject: "Your Iron Wing Dispatching agreement",
                message:
                    "Please review and sign your Iron Wing Dispatching service agreement, limited power of attorney and payment authorization.",
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

/**
 * POST /onboarding/webhooks/signwell. Returns an HTTP status. The event is a
 * hint: authenticity is checked with the webhook id, then the document is
 * re-fetched.
 */
export async function handleSignwellWebhook(deps, body) {
    if (!verifySignwellEvent(body, deps.config.signature.webhookId)) return 401;
    const { type, time } = body.event;
    const documentId = body.data?.object?.id;
    if (typeof documentId !== "string" || documentId.length > 200) return 200;
    const receiptKey = `${type}:${time}:${documentId}`;
    if (await receiptExists(deps.db, "signwell", receiptKey)) return 200;

    const envelope = await deps.db.signatureEnvelope.findUnique({
        where: { provider_document_id: documentId },
    });
    if (envelope) {
        await reconcileEnvelope(deps, envelope.id);
    } else {
        // Possibly an orphan draft from a create call that timed out.
        let remote = null;
        try {
            remote = await deps.signature.get(documentId);
        } catch {
            remote = null;
        }
        const claimed = remote?.metadata?.envelope_id;
        const owner =
            typeof claimed === "string" && /^[0-9a-f-]{36}$/.test(claimed)
                ? await deps.db.signatureEnvelope.findUnique({
                      where: { id: claimed },
                  })
                : null;
        if (
            owner?.state === "ABANDONED" &&
            normalizeProviderStatus(remote.status) === "DRAFT"
        ) {
            await deps.signature.delete(documentId);
            log(deps, "onboarding_orphan_draft_deleted");
        }
    }
    await recordReceipt(deps.db, "signwell", receiptKey);
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
