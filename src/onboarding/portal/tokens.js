import { randomBytes } from "node:crypto";
import { lockRequest } from "../store.js";
import { createPortalToken, parsePortalToken } from "./token.js";

export function portalUrl(config, tokenId) {
    return (
        config.portal.baseUrl +
        "/p/" +
        createPortalToken(config.portal.tokenSecret, tokenId)
    );
}

export async function createRequestToken(tx, requestId, at) {
    return tx.portalToken.create({
        data: {
            id: randomBytes(16).toString("base64url"),
            request_id: requestId,
            created_at: at,
        },
    });
}

export function issuePortalToken(
    deps,
    requestId,
    { revokeExisting = false } = {}
) {
    return deps.db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        if (!row?.portal_flow || row.purged_at || row.cancelled_at) return null;
        const at = deps.now();
        if (revokeExisting)
            await tx.portalToken.updateMany({
                where: { request_id: requestId, revoked_at: null },
                data: { revoked_at: at },
            });
        const token = await createRequestToken(tx, requestId, at);
        return { tokenId: token.id, url: portalUrl(deps.config, token.id) };
    });
}

export async function activePortalUrl(deps, requestId) {
    const token = await deps.db.portalToken.findFirst({
        where: { request_id: requestId, revoked_at: null },
        orderBy: { created_at: "desc" },
    });
    return token ? portalUrl(deps.config, token.id) : null;
}

export async function resolvePortalToken(deps, token) {
    const parsed = parsePortalToken(deps.config.portal?.tokenSecret, token);
    if (parsed.error) return parsed;
    const found = await deps.db.portalToken.findUnique({
        where: { id: parsed.tokenId },
        include: { request: true },
    });
    if (!found) return { error: "invalid" };
    const row = found.request;
    const cutoff =
        deps.now().getTime() - deps.config.portal.linkGraceDays * 86400000;
    // A link works for 30 days after READY or cancellation, or 30 days after
    // it was issued if later (owner ruling 2026-11-19: a re-upload request
    // months after READY gets a fresh link; old links stay dead).
    const ended = [row.ready_at, row.cancelled_at].some(
        (at) => at && at < cutoff
    );
    if (
        found.revoked_at ||
        !row.portal_flow ||
        row.purged_at ||
        (ended && found.created_at < cutoff)
    )
        return { error: "inactive" };
    return { row, tokenId: found.id };
}
