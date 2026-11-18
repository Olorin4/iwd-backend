import { transition } from "./store.js";
import { getClient, setClientKelevoRef } from "../clients/index.js";

const RETRYABLE = ["FAILED", "MANUAL_REQUIRED"];

/**
 * Starts (or retries) provisioning once payment is READY. Returns the new
 * provisioning state or null when not allowed.
 */
export async function startProvisioning(
    deps,
    requestId,
    { retry = false } = {}
) {
    const now = deps.now();
    const claimed = await transition(deps.db, requestId, (row) => {
        if (row.cancelled_at || row.payment_state !== "READY") return null;
        const from = retry ? RETRYABLE : ["NOT_STARTED"];
        if (!from.includes(row.provisioning_state)) return null;
        return {
            provisioning_state: "PENDING",
            provisioning_code: null,
            provisioning_at: now,
        };
    });
    if (!claimed.changed) return null;
    let result;
    try {
        const client = await getClient(deps.db, claimed.row.client_id);
        result = await deps.provisioning.provision({
            client,
            request: claimed.row,
        });
    } catch (error) {
        result = { state: "FAILED", code: "provisioning_call_failed" };
        deps.logger?.error?.({
            code: "onboarding_provisioning_failed",
            reason: error?.code ?? "error",
        });
    }
    if (!["SUCCEEDED", "FAILED", "MANUAL_REQUIRED"].includes(result?.state))
        result = { state: "FAILED", code: "provisioning_bad_result" };
    if (result.state === "SUCCEEDED" && result.kelevoRef)
        await setClientKelevoRef(
            deps.db,
            claimed.row.client_id,
            result.kelevoRef
        );
    await transition(deps.db, requestId, (row) =>
        row.provisioning_state !== "PENDING"
            ? null
            : {
                  provisioning_state: result.state,
                  provisioning_code:
                      result.state === "SUCCEEDED"
                          ? null
                          : (result.code ?? null),
                  kelevo_ref: result.kelevoRef ?? row.kelevo_ref,
                  provisioning_at: deps.now(),
              }
    );
    return result.state;
}

/** Operator confirms a manual Kelevo setup with the Kelevo reference. */
export async function confirmProvisioning(deps, requestId, kelevoRef) {
    const now = deps.now();
    const result = await transition(deps.db, requestId, async (row, tx) => {
        if (row.cancelled_at || !RETRYABLE.includes(row.provisioning_state))
            return null;
        await setClientKelevoRef(tx, row.client_id, kelevoRef);
        return {
            provisioning_state: "MANUAL_CONFIRMED",
            provisioning_code: null,
            kelevo_ref: kelevoRef,
            provisioning_at: now,
        };
    });
    return result.changed;
}
