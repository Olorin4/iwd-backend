// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
//
// Data access for the interim billing tables. Every state change that two
// callers could race on is a single conditional UPDATE or a unique-key
// insert, never read-then-write.

import { prisma } from "../prismaClient.js";
import { AsyncLocalStorage } from "node:async_hooks";
const transactionContext = new AsyncLocalStorage();
const database = () => transactionContext.getStore() ?? prisma;
export function withTransaction(fn) {
    return prisma.$transaction((tx) => transactionContext.run(tx, fn), {
        timeout: 30000,
    });
}

const UNIQUE_VIOLATION = "P2002";

const isUnique = (error) => error?.code === UNIQUE_VIOLATION;

// ---------------------------------------------------------------- runs

/** Creates the run for `runEnd` once; later and concurrent calls get the same row. */
export async function claimRun(runEnd) {
    const existing = await database().interimBillingRun.findUnique({
        where: { run_end: runEnd },
    });
    if (existing) return { run: existing, created: false };
    try {
        const run = await database().interimBillingRun.create({
            data: { run_end: runEnd },
        });
        return { run, created: true };
    } catch (error) {
        if (!isUnique(error)) throw error;
        const run = await database().interimBillingRun.findUnique({
            where: { run_end: runEnd },
        });
        return { run, created: false };
    }
}

export function getRun(id) {
    return database().interimBillingRun.findUnique({ where: { id } });
}

export function getRunByEnd(runEnd) {
    return database().interimBillingRun.findUnique({
        where: { run_end: runEnd },
    });
}

/** Moves a run between statuses only if it is still in one of `fromStatuses`. */
export async function transitionRun(runId, fromStatuses, toStatus, data = {}) {
    const result = await database().interimBillingRun.updateMany({
        where: { id: runId, status: { in: fromStatuses } },
        data: { ...data, status: toStatus },
    });
    return result.count === 1;
}

// --------------------------------------------------------------- lines

/** Inserts lines whose (kelevo_load_id, kind) is new; returns how many were inserted. */
export async function insertLinesIfAbsent(lines) {
    if (lines.length === 0) return 0;
    const result = await database().interimBillingLine.createMany({
        data: lines,
        skipDuplicates: true,
    });
    return result.count;
}

export function getLine(id) {
    return database().interimBillingLine.findUnique({ where: { id } });
}

/** Updates a line only if it is still in one of `fromStatuses`. */
export async function updateLineIf(id, fromStatuses, patch) {
    const result = await database().interimBillingLine.updateMany({
        where: { id, status: { in: fromStatuses } },
        data: patch,
    });
    return result.count === 1;
}

export function listLinesForRun(runId) {
    return database().interimBillingLine.findMany({
        where: { run_id: runId },
        orderBy: { id: "asc" },
    });
}

export function listReadyLinesWithoutInvoice() {
    return database().interimBillingLine.findMany({
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
    const existing = await database().interimBillingInvoice.findUnique({
        where,
    });
    if (existing) return existing;
    try {
        return await database().interimBillingInvoice.create({ data });
    } catch (error) {
        if (!isUnique(error)) throw error;
        return database().interimBillingInvoice.findUnique({ where });
    }
}

export function getInvoice(id) {
    return database().interimBillingInvoice.findUnique({ where: { id } });
}

export function getInvoiceByStripeId(stripeInvoiceId) {
    return database().interimBillingInvoice.findUnique({
        where: { stripe_invoice_id: stripeInvoiceId },
    });
}

export function listInvoicesForRun(runId) {
    return database().interimBillingInvoice.findMany({
        where: { run_id: runId },
        orderBy: { id: "asc" },
    });
}

/** Moves an invoice between statuses only if it is still in one of `fromStatuses`. */
export async function transitionInvoice(id, fromStatuses, toStatus, data = {}) {
    const result = await database().interimBillingInvoice.updateMany({
        where: { id, status: { in: fromStatuses } },
        data: { ...data, status: toStatus },
    });
    return result.count === 1;
}

/** Invoices waiting for a scheduled retry whose time has come. */
export function listDueRetries(now) {
    return database().interimBillingInvoice.findMany({
        where: { status: "retry_scheduled", next_attempt_at: { lte: now } },
        orderBy: { next_attempt_at: "asc" },
    });
}

// ------------------------------------------------------------- carriers

/** Creates a carrier with its driver and truck assets in one transaction. */
export function createCarrier({ driverIds = [], truckIds = [], ...data }) {
    return database().interimBillingCarrier.create({
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
    return database().interimBillingCarrier.findUnique({ where: { id } });
}

export function listCarriers() {
    return database().interimBillingCarrier.findMany({
        orderBy: { id: "asc" },
    });
}

export async function findCarrierByAsset(kind, kelevoId) {
    const asset = await database().interimBillingCarrierAsset.findUnique({
        where: { kind_kelevo_id: { kind, kelevo_id: kelevoId } },
        include: { carrier: true },
    });
    return asset ? asset.carrier : null;
}

export function setStripeCustomerId(carrierId, customerId) {
    return database().interimBillingCarrier.update({
        where: { id: carrierId },
        data: { stripe_customer_id: customerId },
    });
}

/** Stores a saved payment method for the carrier's "primary" or "backup" slot. */
export function setPaymentMethod(carrierId, role, { pmId, brand, last4 }) {
    const slot = role === "primary" ? "primary" : "backup";
    return database().interimBillingCarrier.update({
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
export async function recordStripeEvent(eventId, type, tx = database()) {
    const result = await tx.interimBillingStripeEvent.createMany({
        data: [{ id: eventId, type }],
        skipDuplicates: true,
    });
    return result.count === 1;
}

// Small read helpers used by run construction and startup recovery.
export function listAssets() {
    return database().interimBillingCarrierAsset.findMany();
}
export function listAllLines() {
    return database().interimBillingLine.findMany({ orderBy: { id: "asc" } });
}
export function listMinimumLines() {
    return database().interimBillingLine.findMany({
        where: {
            status: "held",
            hold_reason: "below_minimum",
            invoice_id: null,
        },
    });
}
export function listRunsByStatus(statuses) {
    return database().interimBillingRun.findMany({
        where: { status: { in: statuses } },
        orderBy: { id: "asc" },
    });
}
export function updateInvoiceLines(invoiceId, status) {
    return database().interimBillingLine.updateMany({
        where: { invoice_id: invoiceId },
        data: { status },
    });
}

// A session lock serializes this tiny module across processes, without keeping
// ledger writes in a transaction across Stripe calls. A crashed connection
// releases the lock; committed intent remains available for reconciliation.
export async function withBillingLock(fn) {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.DB_URL });
    await client.connect();
    try {
        const result = await client.query(
            "SELECT pg_try_advisory_lock(174923, 1) AS acquired"
        );
        if (!result.rows[0].acquired) {
            const error = new Error("billing_busy");
            error.code = "billing_busy";
            error.status = 409;
            throw error;
        }
        return await fn();
    } finally {
        await client
            .query("SELECT pg_advisory_unlock(174923, 1)")
            .catch(() => {});
        await client.end();
    }
}

export function listPayingInvoices() {
    return database().interimBillingInvoice.findMany({
        where: { status: "paying" },
        orderBy: { id: "asc" },
    });
}
