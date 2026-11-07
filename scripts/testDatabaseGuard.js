// Integration tests truncate tables and db:test:setup migrates, so neither may
// ever touch a real database. A bad DB_URL (or a missing one, which makes
// Prisma fall back to .env) is a hard stop. Shared by
// __tests__/setup-integration.js and scripts/assertTestDb.js.
export function assertTestDatabase(url) {
    const name = databaseName(url);
    if (name && name.endsWith("_test")) return name;
    throw new Error(
        `Refusing to use test tooling against "${name || "(unset)"}": DB_URL must point at a database whose name ends in _test (export it from .env.test).`
    );
}

function databaseName(url) {
    if (typeof url !== "string" || !url) return undefined;
    const path = url.split("?")[0];
    const afterScheme = path.includes("://") ? path.split("://")[1] : undefined;
    if (!afterScheme || !afterScheme.includes("/")) return undefined;
    return afterScheme.slice(afterScheme.lastIndexOf("/") + 1) || undefined;
}
