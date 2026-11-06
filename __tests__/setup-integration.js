import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { assertTestDatabase } from './testDatabaseGuard';

// Must run before the client is created or any hook is registered.
assertTestDatabase(process.env.DB_URL);

const prisma = new PrismaClient();

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
  await prisma.$executeRaw`TRUNCATE TABLE "sign_up_form" RESTART IDENTITY CASCADE;`;
});

afterAll(async () => {
  await prisma.$disconnect();
});