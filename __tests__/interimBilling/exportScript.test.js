// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.join(
    process.cwd(),
    "src/interimBilling/ops/kelevo-prod/export-loads.sh"
);

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-script-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
        path.join(bin, "docker"),
        `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
cat > "${dir}/stdin"
echo '[]'
`,
        { mode: 0o755 }
    );
    return { dir, bin };
}

function runScript(original) {
    const { dir, bin } = setup();
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    if (original !== undefined) env.SSH_ORIGINAL_COMMAND = original;
    const result = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
    return {
        status: result.status,
        stdout: result.stdout,
        called: fs.existsSync(path.join(dir, "args")),
        args: fs.existsSync(path.join(dir, "args"))
            ? fs.readFileSync(path.join(dir, "args"), "utf8").trim().split("\n")
            : [],
        stdin: fs.existsSync(path.join(dir, "stdin"))
            ? fs.readFileSync(path.join(dir, "stdin"), "utf8")
            : "",
    };
}

describe("export-loads.sh", () => {
    it("calls docker once with a read-only psql call and the two timestamps as variables", () => {
        const result = runScript("2026-11-02T06:00:00Z 2026-11-09T06:00:00Z");
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe("[]");
        expect(result.called).toBe(true);
        expect(result.args.slice(0, 3)).toEqual([
            "exec",
            "-i",
            "postgres-prod",
        ]);
        expect(result.args).toContain("psql");
        expect(result.args).toContain("iwd_billing_ro");
        expect(result.args).toContain("from_ts=2026-11-02T06:00:00Z");
        expect(result.args).toContain("to_ts=2026-11-09T06:00:00Z");
        expect(result.stdin).toContain("iwd_billing_loads(:'from_ts'");
        // Nothing but the fixed command: no extra statements.
        expect(result.stdin.trim().split(";").filter(Boolean)).toHaveLength(1);
    });

    const REJECTED = {
        "an empty value": "",
        "a single timestamp": "2026-11-02T06:00:00Z",
        "three words": "2026-11-02T06:00:00Z 2026-11-09T06:00:00Z extra",
        "a trailing command":
            "2026-11-02T06:00:00Z 2026-11-09T06:00:00Z; rm -rf /",
        "a command substitution": "2026-11-02T06:00:00Z $(id)",
        "a backtick": "2026-11-02T06:00:00Z `id`",
        "an embedded newline": "2026-11-02T06:00:00Z\n2026-11-09T06:00:00Z",
        milliseconds: "2026-11-02T06:00:00.000Z 2026-11-09T06:00:00Z",
        "a different format": "2026-11-02 06:00:00 2026-11-09 06:00:00",
        "an impossible date": "2026-13-02T06:00:00Z 2026-11-09T06:00:00Z",
        "from after to": "2026-11-09T06:00:00Z 2026-11-02T06:00:00Z",
        "from equal to to": "2026-11-09T06:00:00Z 2026-11-09T06:00:00Z",
        "a window over 400 days": "2025-01-01T00:00:00Z 2026-11-09T06:00:00Z",
        "a leading space": " 2026-11-02T06:00:00Z 2026-11-09T06:00:00Z",
    };

    it.each(Object.entries(REJECTED))(
        "refuses %s without calling docker",
        (name, value) => {
            const result = runScript(value);
            expect(result.status).not.toBe(0);
            expect(result.called).toBe(false);
        }
    );

    it("refuses when SSH_ORIGINAL_COMMAND is not set", () => {
        const result = runScript(undefined);
        expect(result.status).not.toBe(0);
        expect(result.called).toBe(false);
    });
});
