// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
//
// Reads Iron Wing's loads from production KelevoTMS through one restricted
// ssh command (see ops/kelevo-prod/), and validates every byte it gets back.
// Errors carry a short code only: never ssh stderr, paths or row contents.

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { toCents } from "./money.js";

export class KelevoReadError extends Error {
    constructor(code) {
        super(`KelevoTMS read failed: ${code}`);
        this.name = "KelevoReadError";
        this.code = code;
    }
}

const MAX_ROWS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
const SSH_TIMEOUT_MS = 30000;
const STATUSES = new Set(["DELIVERED", "PAID", "CANCELED"]);
const ISO_WITH_ZONE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

const defaultRun = promisify(execFile);

const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

function optionalId(value) {
    if (value === null || value === undefined) return null;
    if (!isPositiveInt(value)) throw new KelevoReadError("bad_row");
    return value;
}

function optionalAmount(value) {
    try {
        return toCents(value);
    } catch {
        throw new KelevoReadError("bad_amount");
    }
}

// A date without a zone designator would be read as local time: refuse it.
function optionalDate(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || !ISO_WITH_ZONE.test(value)) {
        throw new KelevoReadError("bad_date");
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new KelevoReadError("bad_date");
    return date;
}

function parseRow(row) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new KelevoReadError("bad_row");
    }
    if (!isPositiveInt(row.id)) throw new KelevoReadError("bad_row");
    if (!STATUSES.has(row.status)) throw new KelevoReadError("bad_status");
    const currency = row.currency ?? "USD";
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
        throw new KelevoReadError("bad_row");
    }
    return {
        id: row.id,
        loadNumber: optionalId(row.load_number),
        status: row.status,
        driverId: optionalId(row.driver_id),
        truckId: optionalId(row.truck_id),
        rateCents: optionalAmount(row.rate),
        currency,
        enteredLinehaulCents: optionalAmount(row.entered_linehaul),
        deliveredAt: optionalDate(row.delivered_at),
        deliveryEnd: optionalDate(row.delivery_end),
        canceledAt: optionalDate(row.canceled_at),
    };
}

/** Validates the JSON the export script prints and converts it to loads. */
export function parseLoadRows(text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) {
        throw new KelevoReadError("too_large");
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new KelevoReadError("invalid_json");
    }
    if (!Array.isArray(data)) throw new KelevoReadError("not_array");
    if (data.length > MAX_ROWS) throw new KelevoReadError("too_many_rows");
    return data.map(parseRow);
}

const isoNoMillis = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Fetches the loads delivered or cancelled in [from, to). `config` is the
 * module config; `run` is injectable for tests. In sandbox mode a JSON file
 * can stand in for production (config.loadsFile).
 */
export async function fetchLoads({ from, to }, config, run = defaultRun) {
    if (config.loadsFile) {
        let text;
        try {
            text = await fs.readFile(config.loadsFile, "utf8");
        } catch {
            throw new KelevoReadError("loads_file_unreadable");
        }
        return parseLoadRows(text);
    }

    const { host, user, keyFile, knownHostsFile } = config.ssh;
    const args = [
        "-i",
        keyFile,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${knownHostsFile}`,
        "-o",
        "ConnectTimeout=10",
        "-o",
        "IdentitiesOnly=yes",
        `${user}@${host}`,
        `${isoNoMillis(from)} ${isoNoMillis(to)}`,
    ];

    let stdout;
    try {
        ({ stdout } = await run("ssh", args, {
            timeout: SSH_TIMEOUT_MS,
            maxBuffer: MAX_BYTES + 1024,
        }));
    } catch {
        throw new KelevoReadError("ssh_failed");
    }
    return parseLoadRows(stdout);
}
