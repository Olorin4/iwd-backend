import { randomUUID } from "node:crypto";

// Client persistence. `db` is a Prisma client or transaction client.

/**
 * Returns the Client with this USDOT number, creating it from the confirmed
 * terms when none exists. Safe under concurrency: the insert is
 * ON CONFLICT DO NOTHING on the unique usdot, then the row is read back.
 * An existing Client's identity fields are never overwritten.
 */
export async function findOrCreateClientForTerms(
    db,
    terms,
    { outreachPartyId = null } = {}
) {
    await db.$executeRaw`
        INSERT INTO "client" ("id", "legal_name", "dba_name", "mc_number", "usdot",
            "primary_email", "status", "outreach_party_id", "created_at", "updated_at")
        VALUES (${randomUUID()}, ${terms.legal_name}, ${terms.dba_name}, ${terms.mc_number},
            ${terms.usdot}, ${terms.recipient_email}, 'ONBOARDING', ${outreachPartyId}, now(), now())
        ON CONFLICT ("usdot") DO NOTHING`;
    return db.client.findUnique({ where: { usdot: terms.usdot } });
}

export const getClient = (db, id) => db.client.findUnique({ where: { id } });

export const setStripeCustomerId = (db, id, customerId) =>
    db.client.update({
        where: { id },
        data: { stripe_customer_id: customerId },
    });

export const setClientPaymentMethod = (db, id, { pmId, type, last4, brand }) =>
    db.client.update({
        where: { id },
        data: {
            payment_method_id: pmId,
            payment_method_type: type,
            payment_last4: last4,
            payment_brand: brand,
        },
    });

export const setClientKelevoRef = (db, id, kelevoRef) =>
    db.client.update({ where: { id }, data: { kelevo_ref: kelevoRef } });

export const setClientStatus = (db, id, status) =>
    db.client.update({ where: { id }, data: { status } });
