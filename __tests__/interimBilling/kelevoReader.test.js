// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import fs from "fs";
import os from "os";
import path from "path";
import {
    parseLoadRows,
    fetchLoads,
    KelevoReadError,
} from "../../src/interimBilling/kelevoReader";

const row = (overrides = {}) => ({
    id: 101,
    load_number: 1234,
    status: "DELIVERED",
    driver_id: 11,
    truck_id: 21,
    rate: "2500.00",
    currency: "USD",
    entered_linehaul: "2400.00",
    delivered_at: "2026-11-12T15:00:00Z",
    delivery_end: "2026-11-12T16:00:00Z",
    canceled_at: null,
    ...overrides,
});

const codeOf = (fn) => {
    try {
        fn();
    } catch (error) {
        expect(error).toBeInstanceOf(KelevoReadError);
        return error.code;
    }
    throw new Error("expected a KelevoReadError");
};

describe("parseLoadRows", () => {
    it("converts a valid row to cents and dates", () => {
        const [load] = parseLoadRows(JSON.stringify([row()]));
        expect(load).toEqual({
            id: 101,
            loadNumber: 1234,
            status: "DELIVERED",
            driverId: 11,
            truckId: 21,
            rateCents: 250000,
            currency: "USD",
            enteredLinehaulCents: 240000,
            deliveredAt: new Date("2026-11-12T15:00:00Z"),
            deliveryEnd: new Date("2026-11-12T16:00:00Z"),
            canceledAt: null,
        });
    });

    it("accepts nulls for the optional fields and a cancelled load", () => {
        const [load] = parseLoadRows(
            JSON.stringify([
                row({
                    status: "CANCELED",
                    load_number: null,
                    driver_id: null,
                    truck_id: null,
                    rate: null,
                    entered_linehaul: null,
                    delivered_at: null,
                    delivery_end: null,
                    canceled_at: "2026-11-13T10:00:00+00:00",
                }),
            ])
        );
        expect(load.loadNumber).toBeNull();
        expect(load.rateCents).toBeNull();
        expect(load.enteredLinehaulCents).toBeNull();
        expect(load.canceledAt).toEqual(new Date("2026-11-13T10:00:00Z"));
    });

    it("accepts an empty array", () => {
        expect(parseLoadRows("[]")).toEqual([]);
    });

    it("rejects malformed output with a distinct code and never echoes the content", () => {
        expect(codeOf(() => parseLoadRows("not json {"))).toBe("invalid_json");
        expect(codeOf(() => parseLoadRows('{"a":1}'))).toBe("not_array");
        expect(codeOf(() => parseLoadRows("[1]"))).toBe("bad_row");
        expect(
            codeOf(() =>
                parseLoadRows(JSON.stringify([row({ id: undefined })]))
            )
        ).toBe("bad_row");
        expect(
            codeOf(() => parseLoadRows(JSON.stringify([row({ id: -4 })])))
        ).toBe("bad_row");
        expect(
            codeOf(() =>
                parseLoadRows(JSON.stringify([row({ status: "DRAFTED" })]))
            )
        ).toBe("bad_status");
        expect(
            codeOf(() =>
                parseLoadRows(JSON.stringify([row({ rate: "-5.00" })]))
            )
        ).toBe("bad_amount");
        expect(
            codeOf(() =>
                parseLoadRows(JSON.stringify([row({ rate: "12.345" })]))
            )
        ).toBe("bad_amount");
        expect(
            codeOf(() =>
                parseLoadRows(
                    JSON.stringify([row({ delivered_at: "not a date" })])
                )
            )
        ).toBe("bad_date");
    });

    it("rejects a date with no zone designator (it would be read as local time)", () => {
        expect(
            codeOf(() =>
                parseLoadRows(
                    JSON.stringify([
                        row({ delivered_at: "2026-11-12T15:00:00" }),
                    ])
                )
            )
        ).toBe("bad_date");
    });

    it("rejects more than 5000 rows and output over 2 MB", () => {
        const many = JSON.stringify(Array.from({ length: 5001 }, () => row()));
        expect(codeOf(() => parseLoadRows(many))).toBe("too_many_rows");
        expect(
            codeOf(() => parseLoadRows(" ".repeat(2 * 1024 * 1024 + 1)))
        ).toBe("too_large");
    });
});

describe("fetchLoads", () => {
    const config = {
        ssh: {
            host: "100.64.0.9",
            user: "iwdbilling",
            keyFile: "/run/interim-billing/key",
            knownHostsFile: "/run/interim-billing/known_hosts",
        },
        loadsFile: null,
    };
    const range = {
        from: new Date("2026-11-02T06:00:00Z"),
        to: new Date("2026-11-09T06:00:00Z"),
    };

    it("makes exactly one ssh call, without a shell, with the pinned options and the window as one argument", async () => {
        const run = jest
            .fn()
            .mockResolvedValue({ stdout: JSON.stringify([row()]) });
        const loads = await fetchLoads(range, config, run);
        expect(loads).toHaveLength(1);
        expect(run).toHaveBeenCalledTimes(1);
        const [file, args, options] = run.mock.calls[0];
        expect(file).toBe("ssh");
        expect(args).toEqual([
            "-i",
            "/run/interim-billing/key",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "UserKnownHostsFile=/run/interim-billing/known_hosts",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "IdentitiesOnly=yes",
            "iwdbilling@100.64.0.9",
            "2026-11-02T06:00:00Z 2026-11-09T06:00:00Z",
        ]);
        expect(options.timeout).toBe(30000);
        expect(options.shell).toBeUndefined();
    });

    it("turns an ssh failure into a coded error without the stderr text", async () => {
        const failure = Object.assign(new Error("Command failed"), {
            stderr: "Permission denied for key /secret/path",
            code: 255,
        });
        const run = jest.fn().mockRejectedValue(failure);
        let caught;
        try {
            await fetchLoads(range, config, run);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(KelevoReadError);
        expect(caught.code).toBe("ssh_failed");
        expect(caught.message).not.toContain("/secret/path");
        expect(caught.message).not.toContain("Permission denied");
    });

    it("rejects malformed ssh output", async () => {
        const run = jest.fn().mockResolvedValue({ stdout: "garbage" });
        await expect(fetchLoads(range, config, run)).rejects.toMatchObject({
            code: "invalid_json",
        });
    });

    it("reads a JSON file instead of calling ssh when loadsFile is set", async () => {
        const file = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), "ib-loads-")),
            "loads.json"
        );
        fs.writeFileSync(file, JSON.stringify([row({ id: 7 })]));
        const run = jest.fn();
        const loads = await fetchLoads(
            range,
            { ...config, loadsFile: file },
            run
        );
        expect(loads.map((l) => l.id)).toEqual([7]);
        expect(run).not.toHaveBeenCalled();
    });
});
