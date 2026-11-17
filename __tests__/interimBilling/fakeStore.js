// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
export function fakeStore() {
    const runs = [],
        lines = [],
        invoices = [],
        carriers = [
            {
                id: 1,
                fee_bp: 500,
                legal_name: '<hostile>"\n',
                email: "billing@example.com",
                stripe_customer_id: "cus_1",
                primary_pm_id: "pm_primary",
                backup_pm_id: "pm_backup",
            },
        ];
    const transition = (rows, id, from, status, data = {}) => {
        const row = rows.find((r) => r.id === id);
        if (!row || !from.includes(row.status)) return false;
        Object.assign(row, data, { status });
        return true;
    };
    return {
        withTransaction: async (fn) => fn(),
        listUnnotifiedFailures: async () =>
            invoices.filter((i) => i.status === "failed_notifying"),
        runs,
        lines,
        invoices,
        carriers,
        withBillingLock: async (fn) => fn(),
        listAssets: async () => [
            {
                kind: "DRIVER",
                kelevo_id: 7,
                carrier_id: 1,
                effective_from: new Date(0),
            },
        ],
        listCarriers: async () => carriers,
        getCarrier: async (id) => carriers.find((r) => r.id === id),
        getRun: async (id) => runs.find((r) => r.id === id),
        getRunByEnd: async (end) => runs.find((r) => +r.run_end === +end),
        listRunsByStatus: async (statuses) =>
            runs.filter((r) => statuses.includes(r.status)),
        claimRun: async (end) => {
            let run = runs.find((r) => +r.run_end === +end);
            const created = !run;
            if (!run) {
                run = { id: runs.length + 1, run_end: end, status: "building" };
                runs.push(run);
            }
            return { run, created };
        },
        transitionRun: async (...args) => transition(runs, ...args),
        listAllLines: async () => lines,
        listLinesForRun: async (id) => lines.filter((l) => l.run_id === id),
        getLine: async (id) => lines.find((l) => l.id === id),
        insertLinesIfAbsent: async (rows) => {
            for (const r of rows)
                if (
                    !lines.some(
                        (l) =>
                            l.kelevo_load_id === r.kelevo_load_id &&
                            l.kind === r.kind
                    )
                )
                    lines.push({
                        id: lines.length + 1,
                        invoice_id: null,
                        ...r,
                    });
        },
        updateLineIf: async (id, from, patch) => {
            const row = lines.find((l) => l.id === id);
            if (!row || !from.includes(row.status)) return false;
            Object.assign(row, patch);
            return true;
        },
        listReadyLinesWithoutInvoice: async () =>
            lines.filter((l) => l.status === "ready" && !l.invoice_id),
        listMinimumLines: async () =>
            lines.filter(
                (l) => l.hold_reason === "below_minimum" && !l.invoice_id
            ),
        createInvoiceRow: async (row) => {
            let result = invoices.find(
                (i) =>
                    i.run_id === row.run_id && i.carrier_id === row.carrier_id
            );
            if (!result) {
                result = {
                    id: invoices.length + 1,
                    status: "draft",
                    round: 0,
                    attempts: 0,
                    tried_backup_this_round: false,
                    ...row,
                };
                invoices.push(result);
            }
            return result;
        },
        getInvoice: async (id) => invoices.find((i) => i.id === id),
        listInvoicesForRun: async (id) =>
            invoices.filter((i) => i.run_id === id),
        transitionInvoice: async (...args) => transition(invoices, ...args),
        listDueRetries: async (now) =>
            invoices.filter(
                (i) =>
                    i.status === "retry_scheduled" && i.next_attempt_at <= now
            ),
        updateInvoiceLines: async (id, status) => {
            for (const l of lines) if (l.invoice_id === id) l.status = status;
        },
    };
}
