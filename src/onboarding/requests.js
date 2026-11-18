import { onboardingRequestV1 } from "./contracts.js";
import { termsHash } from "./canonical.js";
import { initialOperations } from "./readiness.js";
import { currentStatus, writeStatusEvent } from "./store.js";
import { findOrCreateClientForTerms } from "../clients/index.js";

export class OnboardingError extends Error {
    constructor(code, status = 400, extra = {}) {
        super(code);
        this.name = "OnboardingError";
        this.code = code;
        this.status = status;
        this.extra = extra;
    }
}

const issuesOf = (error) =>
    error.issues
        .slice(0, 20)
        .map((issue) => ({ path: issue.path.join("."), code: issue.code }));

const existingResult = async (db, existing, hash) => {
    if (existing.terms_hash !== hash)
        throw new OnboardingError("terms_mismatch", 409);
    return {
        status: 200,
        body: await currentStatus(db, existing),
        created: false,
        row: existing,
    };
};

/**
 * PUT /onboarding/requests/:idempotencyKey. 201 new, 200 same key and hash,
 * 409 terms_mismatch, 422 invalid/terms_hash_mismatch. Concurrent identical
 * PUTs converge: the unique idempotency key makes all but one insert fail,
 * and those re-read the winner.
 */
export async function putRequest(deps, key, body) {
    const parsed = onboardingRequestV1.safeParse(body);
    if (!parsed.success)
        throw new OnboardingError("invalid_request", 422, {
            issues: issuesOf(parsed.error),
        });
    const input = parsed.data;
    if (input.idempotency_key !== key)
        throw new OnboardingError("idempotency_key_mismatch", 422);
    const hash = termsHash(input.terms);
    if (hash !== input.terms_hash)
        throw new OnboardingError("terms_hash_mismatch", 422);

    const { db } = deps;
    const existing = await db.onboardingRequest.findUnique({
        where: { idempotency_key: key },
    });
    if (existing) return existingResult(db, existing, hash);

    try {
        const { row, status } = await db.$transaction(async (tx) => {
            const client = await findOrCreateClientForTerms(tx, input.terms, {
                outreachPartyId: input.source_refs.party_id,
            });
            const created = await tx.onboardingRequest.create({
                data: {
                    idempotency_key: key,
                    source: input.source,
                    source_refs: input.source_refs,
                    actor: input.actor,
                    terms: input.terms,
                    terms_hash: hash,
                    confirmed_at: new Date(input.confirmed_at),
                    client_id: client.id,
                    operations: initialOperations(),
                },
            });
            return {
                row: created,
                status: await writeStatusEvent(tx, created, deps.now()),
            };
        });
        return { status: 201, body: status, created: true, row };
    } catch (error) {
        if (error?.code !== "P2002") throw error;
        const winner = await db.onboardingRequest.findUnique({
            where: { idempotency_key: key },
        });
        if (!winner) throw error;
        return existingResult(db, winner, hash);
    }
}

export async function getRequestStatus(deps, key) {
    const row = await deps.db.onboardingRequest.findUnique({
        where: { idempotency_key: key },
    });
    if (!row) throw new OnboardingError("not_found", 404);
    return currentStatus(deps.db, row);
}

export async function findRequestByKey(db, key) {
    const row = await db.onboardingRequest.findUnique({
        where: { idempotency_key: key },
    });
    if (!row) throw new OnboardingError("not_found", 404);
    return row;
}
