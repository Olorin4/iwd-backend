// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import fs from "node:fs";
it("exports undated cancellations for reporting independently of delivery windows", () => {
    const sql = fs.readFileSync(
        "src/interimBilling/ops/kelevo-prod/01-iwd_billing_loads.sql",
        "utf8"
    );
    expect(sql).toMatch(
        /OR\s*\(l.status::text = 'CANCELED' AND l.canceled_at IS NULL\)/
    );
});
