// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
//
// Data access for the interim billing tables. Every state change that two
// callers could race on is a single conditional UPDATE or a unique-key
// insert, never read-then-write.

import { prisma } from "../prismaClient.js";

const UNIQUE_VIOLATION = "P2002";

const isUnique = (error) => error?.code === UNIQUE_VIOLATION;

// ---------------------------------------------------------------- runs

/** Creates the run for `runEnd` once; later and concurrent calls get the same row. */
export async function claimRun(runEnd) {
    const existing = await prisma.interimBillingRun.findUnique({
        where: { run_end: runEnd },
    });
    if (existing) return { run: existing, created: false };
    try {
        const run = await prisma.interimBillingRun.create({
            data: { run_end: runEnd },
        });
        return { run, created: true };
    } catch (error) {
        if (!isUnique(error)) throw error;
        const run = await prisma.interimBillingRun.findUnique({
            where: { run_end: runEnd },
        });
        return { run, created: false };
    }
}

export function getRun(id) {
    return prisma.interimBillingRun.findUnique({ where: { id } });
}

export function getRunByEnd(runEnd) {
    return prisma.interimBillingRun.findUnique({ where: { run_end: runEnd } });
}

/** Moves a run between statuses only if it is still in one of `fromStatuses`. */
export async function transitionRun(runId, fromStatuses, toStatus, data = {}) {
    const result = await prisma.interimBillingRun.updateMany({
        where: { id: runId, status: { in: fromStatuses } },
        data: { ...data, status: toStatus },
    });
    return result.count === 1;
}

// --------------------------------------------------------------- lines

/** Inserts lines whose (kelevo_load_id, kind) is new; returns how many were inserted. */
export async function insertLinesIfAbsent(lines) {
    if (lines.length === 0) return 0;
    const result = await prisma.interimBillingLine.createMany({
        data: lines,
        skipDuplicates: true,
    });
    return result.count;
}

export function getLine(id) {
    return prisma.interimBillingLine.findUnique({ where: { id } });
}

/** Updates a line only if it is still in one of `fromStatuses`. */
export async function updateLineIf(id, fromStatuses, patch) {
    const result = await prisma.interimBillingLine.updateMany({
        where: { id, status: { in: fromStatuses } },
        data: patch,
    });
    return result.count === 1;
}

export function listLinesForRun(runId) {
    return prisma.interimBillingLine.findMany({
        where: { run_id: runId },
        orderBy: { id: "asc" },
    });
}

export function listReadyLinesWithoutInvoice() {
    return prisma.interimBillingLine.findMany({
        where: { status: "ready", invoice_id: null },
        orderBy: { id: "asc" },
    });
}

// ------------------------------------------------------------ invoices

/** One invoice row per (run, carrier); an existing row is returned unchanged. */
export async function createInvoiceRow(data) {
    const where = {
        run_id_carrier_id: { run_id: data.run_id, carrier_id: data.carrier_id },
    };
    const existing = await prisma.interimBillingInvoice.findUnique({ where });
    if (existing) return existing;
    try {
        return await prisma.interimBillingInvoice.create({ data });
    } catch (error) {
        if (!isUnique(error)) throw error;
        return prisma.interimBillingInvoice.findUnique({ where });
    }
}

export function getInvoice(id) {
    return prisma.interimBillingInvoice.findUnique({ where: { id } });
}

export function getInvoiceByStripeId(stripeInvoiceId) {
    return prisma.interimBillingInvoice.findUnique({
        where: { stripe_invoice_id: stripeInvoiceId },
    });
}

export function listInvoicesForRun(runId) {
    return prisma.interimBillingInvoice.findMany({
        where: { run_id: runId },
        orderBy: { id: "asc" },
    });
}

/** Moves an invoice between statuses only if it is still in one of `fromStatuses`. */
export async function transitionInvoice(id, fromStatuses, toStatus, data = {}) {
    const result = await prisma.interimBillingInvoice.updateMany({
        where: { id, status: { in: fromStatuses } },
        data: { ...data, status: toStatus },
    });
    return result.count === 1;
}

/** Invoices waiting for a scheduled retry whose time has come. */
export function listDueRetries(now) {
    return prisma.interimBillingInvoice.findMany({
        where: { status: "retry_scheduled", next_attempt_at: { lte: now } },
        orderBy: { next_attempt_at: "asc" },
    });
}

// ------------------------------------------------------------- carriers

/** Creates a carrier with its driver and truck assets in one transaction. */
export function createCarrier({ driverIds = [], truckIds = [], ...data }) {
    return prisma.interimBillingCarrier.create({
        data: {
            ...data,
            assets: {
                create: [
                    ...driverIds.map((kelevo_id) => ({
                        kind: "DRIVER",
                        kelevo_id,
                    })),
                    ...truckIds.map((kelevo_id) => ({
                        kind: "TRUCK",
                        kelevo_id,
                    })),
                ],
            },
        },
    });
}

export function getCarrier(id) {
    return prisma.interimBillingCarrier.findUnique({ where: { id } });
}

export function listCarriers() {
    return prisma.interimBillingCarrier.findMany({ orderBy: { id: "asc" } });
}

export async function findCarrierByAsset(kind, kelevoId) {
    const asset = await prisma.interimBillingCarrierAsset.findUnique({
        where: { kind_kelevo_id: { kind, kelevo_id: kelevoId } },
        include: { carrier: true },
    });
    return asset ? asset.carrier : null;
}

export function setStripeCustomerId(carrierId, customerId) {
    return prisma.interimBillingCarrier.update({
        where: { id: carrierId },
        data: { stripe_customer_id: customerId },
    });
}

/** Stores a saved payment method for the carrier's "primary" or "backup" slot. */
export function setPaymentMethod(carrierId, role, { pmId, brand, last4 }) {
    const slot = role === "primary" ? "primary" : "backup";
    return prisma.interimBillingCarrier.update({
        where: { id: carrierId },
        data: {
            [`${slot}_pm_id`]: pmId,
            [`${slot}_pm_brand`]: brand,
            [`${slot}_pm_last4`]: last4,
        },
    });
}

// ------------------------------------------------------- stripe events

/**
 * Remembers a Stripe event id. Returns false if it was already recorded.
 * Pass the transaction client as `tx` to record it with the event's effect.
 */
export async function recordStripeEvent(eventId, type, tx = prisma) {
    try {
        await tx.interimBillingStripeEvent.create({
            data: { id: eventId, type },
        });
        return true;
    } catch (error) {
        if (isUnique(error)) return false;
        throw error;
    }
}
