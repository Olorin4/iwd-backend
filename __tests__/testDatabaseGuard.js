// Integration tests truncate tables, so they must never run against a real
// database. A bad DB_URL (or a missing one, which makes Prisma fall back to
// .env) is a hard stop.
export function assertTestDatabase(url) {
    const name = databaseName(url);
    if (name && name.endsWith("_test")) return name;
    throw new Error(
        `Refusing to run integration tests against "${name || "(unset)"}": DB_URL must point at a database whose name ends in _test (export it from .env.test).`
    );
}

function databaseName(url) {
    if (typeof url !== "string" || !url) return undefined;
    const path = url.split("?")[0];
    const afterScheme = path.includes("://") ? path.split("://")[1] : undefined;
    if (!afterScheme || !afterScheme.includes("/")) return undefined;
    return afterScheme.slice(afterScheme.lastIndexOf("/") + 1) || undefined;
}
