// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve("src/interimBilling");
function files(dir) {
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
            entry.isDirectory()
                ? files(path.join(dir, entry.name))
                : [path.join(dir, entry.name)]
        );
}
it("every module file starts with the disposal banner", () => {
    for (const file of files(root))
        expect(
            fs.readFileSync(file, "utf8").split("\n").slice(0, 3).join("\n")
        ).toContain(
            "TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md."
        );
});
it("documents every hook and links existing anchors", () => {
    const doc = fs.readFileSync(path.join(root, "DISPOSE.md"), "utf8");
    for (const [file, anchor] of [
        ["src/router.js", 'router.use("/interim-billing"'],
        ["src/app.js", "verify: interimBillingRawBody"],
        ["package.json", '"stripe"'],
        ["prisma/schema.prisma", "model InterimBillingCarrier"],
        ["Dockerfile", "openssh-client"],
        ["docker-compose.yml", "/run/interim-billing:ro"],
        [".github/workflows/ci-cd-pipeline.yml", "INTERIM_BILLING_ENABLED"],
        ["__tests__/setup-integration.js", 'includes("interimBilling")'],
    ]) {
        expect(doc).toContain(file);
        expect(fs.readFileSync(file, "utf8")).toContain(anchor);
    }
    expect(fs.existsSync(path.join(root, "SANDBOX-TEST.md"))).toBe(true);
});
