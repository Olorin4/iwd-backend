// Provisioning port: provision({ client, request }) → { state, code?, kelevoRef? }
// state ∈ SUCCEEDED | FAILED | MANUAL_REQUIRED. Must be idempotent on client.id.

/** Manual adapter: an operator provisions in Kelevo, then confirm_provisioning. */
export const manualProvisioning = {
    name: "manual",
    async provision() {
        return {
            state: "MANUAL_REQUIRED",
            code: "manual_provisioning_required",
        };
    },
};

/**
 * Kelevo adapter stub. The scoped agency-client API is pending Kelevo
 * PRD-0020 (see docs/superpowers/specs/2026-11-18-kelevo-provisioning-contract-input.md),
 * so it never calls Kelevo and always asks for manual provisioning.
 */
export const kelevoProvisioningStub = {
    name: "kelevo",
    async provision() {
        return { state: "MANUAL_REQUIRED", code: "kelevo_api_unavailable" };
    },
};

export const provisioningFromConfig = (config) =>
    config.provisioning?.adapter === "kelevo"
        ? kelevoProvisioningStub
        : manualProvisioning;
