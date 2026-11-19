import { addBusinessDays, REMINDER_BUSINESS_DAYS } from "./businessDays.js";
import { replyToOf } from "./documentsFlow.js";
import { missingCarrierSlots } from "./readiness.js";
import { applyFacetChange, lockRequest } from "./store.js";
import {
    activePortalUrl,
    createRequestToken,
    portalUrl,
} from "./portal/tokens.js";
import {
    invitationEmail,
    portalReminderEmail,
    reuploadEmail,
    portalItemLabel,
    PORTAL_REQUIRED_SLOTS,
} from "./portalEmails.js";

const STALE_INVITATION_MS = 30 * 60 * 1000;
const MAX_INVITE_ATTEMPTS = 3;
const MAX_REMINDERS = REMINDER_BUSINESS_DAYS.length;

async function mail(deps, row, copy) {
    await deps.sendEmail({
        from: deps.config.email.from,
        to: row.terms.recipient_email,
        ...replyToOf(deps.config),
        ...copy,
    });
}

export async function sendPortalInvitation(
    deps,
    requestId,
    { resend = false } = {}
) {
    if (!deps.config.portal?.enabled) return false;
    const { db } = deps;
    const at = deps.now();
    const claim = await db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        if (
            !row?.portal_flow ||
            row.cancelled_at ||
            row.purged_at ||
            (row.ready_at &&
                at - row.ready_at >
                    deps.config.portal.linkGraceDays * 86400000) ||
            (row.signature_waiting_for !== "CARRIER" &&
                row.signature_state !== "COMPLETED" &&
                !(resend && row.portal_invited_at)) ||
            (!resend &&
                (row.portal_invited_at ||
                    row.portal_invite_attempts >= MAX_INVITE_ATTEMPTS)) ||
            (row.portal_invite_claimed_at &&
                at - row.portal_invite_claimed_at < STALE_INVITATION_MS)
        )
            return null;
        const active = await tx.portalToken.findFirst({
            where: { request_id: requestId, revoked_at: null },
            orderBy: { created_at: "desc" },
        });
        // The first token is installed before creating the SignWell envelope,
        // which already references it. A staff resend rotates the link.
        const token =
            resend || !active
                ? await createRequestToken(tx, requestId, at)
                : active;
        await tx.onboardingRequest.update({
            where: { id: requestId },
            data: {
                portal_invite_claimed_at: at,
                portal_invite_attempts: { increment: 1 },
            },
        });
        return { row, token, rotated: token.id !== active?.id };
    });
    if (!claim) return false;
    try {
        await mail(
            deps,
            claim.row,
            invitationEmail({
                terms: claim.row.terms,
                url: portalUrl(deps.config, claim.token.id),
            })
        );
    } catch {
        await db.$transaction(async (tx) => {
            const row = await lockRequest(tx, requestId);
            if (Number(row.portal_invite_claimed_at) !== Number(at)) return;
            await tx.onboardingRequest.update({
                where: { id: requestId },
                data: { portal_invite_claimed_at: null },
            });
            if (claim.rotated)
                await tx.portalToken.update({
                    where: { id: claim.token.id },
                    data: { revoked_at: deps.now() },
                });
        });
        deps.logger?.error?.({ code: "onboarding_portal_invitation_failed" });
        return false;
    }
    return db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        if (Number(row.portal_invite_claimed_at) !== Number(at)) return false;
        await tx.portalToken.updateMany({
            where: {
                request_id: requestId,
                id: { not: claim.token.id },
                revoked_at: null,
            },
            data: { revoked_at: at },
        });
        await tx.onboardingRequest.update({
            where: { id: requestId },
            data: { portal_invite_claimed_at: null },
        });
        await applyFacetChange(tx, row, { portal_invited_at: at }, deps.now());
        return true;
    });
}

export function portalMissingSteps(row) {
    const missing = missingCarrierSlots(row.operations).filter((key) =>
        PORTAL_REQUIRED_SLOTS.includes(key)
    );
    return [
        ...(row.signature_state === "COMPLETED" ? [] : ["Sign your agreement"]),
        ...(["READY", "PENDING_VERIFICATION"].includes(row.payment_state)
            ? []
            : ["Save your payment method"]),
        ...missing.map((key) => portalItemLabel(key, row.terms)),
    ];
}

async function sendPortalReminder(deps, requestId, build) {
    if (!deps.config.portal?.enabled) return false;
    const now = deps.now();
    const claim = await deps.db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        if (
            !row?.portal_flow ||
            !row.portal_invited_at ||
            row.cancelled_at ||
            row.purged_at ||
            row.reminders_paused ||
            row.reminders_sent >= MAX_REMINDERS
        )
            return null;
        const url = await activePortalUrl({ ...deps, db: tx }, requestId);
        if (!url) return null;
        const copy = build(row, url, now);
        if (!copy) return null;
        // Reserve before handing off to SMTP. An ambiguous SMTP failure still
        // consumes the slot so recovery cannot send more than two reminders.
        await applyFacetChange(
            tx,
            row,
            { reminders_sent: row.reminders_sent + 1 },
            now
        );
        return { row, copy };
    });
    if (!claim) return false;
    try {
        await mail(deps, claim.row, claim.copy);
        return true;
    } catch {
        deps.logger?.error?.({ code: "onboarding_portal_reminder_failed" });
        return false;
    }
}

export function sendDuePortalReminder(deps, requestId) {
    return sendPortalReminder(deps, requestId, (row, url, now) => {
        if (["DECLINED", "EXPIRED", "CANCELLED"].includes(row.signature_state))
            return null;
        const days = REMINDER_BUSINESS_DAYS[row.reminders_sent];
        if (now < addBusinessDays(row.portal_invited_at, days)) return null;
        const missing = portalMissingSteps(row);
        return missing.length
            ? portalReminderEmail({ terms: row.terms, url, missing })
            : null;
    });
}

export function sendPortalReupload(deps, requestId, key, reason) {
    return sendPortalReminder(deps, requestId, (row, url) =>
        reuploadEmail({
            terms: row.terms,
            url,
            itemLabel: portalItemLabel(key, row.terms),
            reason,
        })
    );
}

export async function portalReminderIds(deps) {
    if (!deps.config.portal?.enabled) return [];
    const rows = await deps.db.onboardingRequest.findMany({
        where: {
            portal_flow: true,
            cancelled_at: null,
            purged_at: null,
            reminders_paused: false,
            reminders_sent: { lt: MAX_REMINDERS },
            portal_invited_at: {
                lte: new Date(deps.now().getTime() - 3 * 86400000),
            },
        },
        select: { id: true },
    });
    return rows.map(({ id }) => id);
}
