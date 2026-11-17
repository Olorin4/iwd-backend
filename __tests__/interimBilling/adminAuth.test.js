// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { requireInterimAdmin } from "../../src/interimBilling/adminAuth.js";
const token = "x".repeat(32);
function check(config, supplied) {
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    requireInterimAdmin(() => config)(
        { headers: { authorization: supplied } },
        res,
        next
    );
    return { next, res };
}
it("rejects missing, wrong, short and lead-list tokens", () => {
    process.env.ADMIN_API_TOKEN = "y".repeat(32);
    for (const value of [
        undefined,
        "Bearer wrong",
        "Bearer a",
        `Bearer ${process.env.ADMIN_API_TOKEN}`,
    ])
        expect(
            check({ enabled: true, adminToken: token }, value).res.status
        ).toHaveBeenCalledWith(401);
    delete process.env.ADMIN_API_TOKEN;
});
it("passes a matching dedicated token", () =>
    expect(
        check({ enabled: true, adminToken: token }, `Bearer ${token}`).next
    ).toHaveBeenCalled());
it("fails closed when disabled, unset or misconfigured", () => {
    expect(
        check({ enabled: false }, `Bearer ${token}`).res.status
    ).toHaveBeenCalledWith(404);
    expect(
        check({ enabled: true }, `Bearer ${token}`).res.status
    ).toHaveBeenCalledWith(401);
});
