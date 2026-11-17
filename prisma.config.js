// Prisma 7 CLI configuration. Prisma 7 no longer loads .env files itself, and
// the datasource URL lives here instead of schema.prisma. In Docker the
// variables come from env_file; locally dotenv-flow supplies them.
import "dotenv-flow/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: { path: "prisma/migrations" },
    datasource: {
        // Read lazily-tolerant: `prisma generate` at image build has no DB_URL.
        url: process.env.DB_URL,
    },
});
