// Exits non-zero unless DB_URL names a *_test database. Run before
// `prisma migrate deploy` in db:test:setup so it can never migrate production.
import { assertTestDatabase } from "./testDatabaseGuard.js";

try {
    const name = assertTestDatabase(process.env.DB_URL);
    console.log(`Test database guard: OK (${name})`);
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
