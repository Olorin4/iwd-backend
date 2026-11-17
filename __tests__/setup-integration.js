import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { execSync } from 'child_process';
import { assertTestDatabase } from '../scripts/testDatabaseGuard';

// Must run before the client is created or any hook is registered.
assertTestDatabase(process.env.DB_URL);

// Prisma 7 connects through a driver adapter, as src/prismaClient.js does.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DB_URL }),
});

beforeAll(() => {
  execSync('npx prisma migrate deploy --schema=./prisma/schema.prisma', {
    env: {
      ...process.env,
      DB_URL: process.env.DB_URL,
      DATABASE_URL: process.env.DB_URL,
    },
  });
});

beforeEach(async () => {
  // TEMPORARY (interim billing): its integration tests share this database and
  // run in parallel with the sign-up suite, so they must not wipe the sign-up
  // table under it. Delete these two lines with the feature. See
  // src/interimBilling/DISPOSE.md.
  if (expect.getState().testPath?.includes("interimBilling")) return;
  await prisma.$executeRaw`TRUNCATE TABLE "sign_up_form" RESTART IDENTITY CASCADE;`;
});

afterAll(async () => {
  await prisma.$disconnect();
});