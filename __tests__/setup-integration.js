import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const prisma = new PrismaClient();

beforeAll(() => {
  execSync('npx prisma migrate deploy --schema=./prisma/schema.prisma', {
    env: { ...process.env, DATABASE_URL: process.env.DB_URL },
  });
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE "sign_up_form" RESTART IDENTITY CASCADE;`;
});

afterAll(async () => {
  await prisma.$disconnect();
});