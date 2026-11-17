/* prismaClient.js initializes a global database connection that is used throughout the application. */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Ensure only one instance of PrismaClient is created and reused.
// Prisma 7 requires a driver adapter; the connection string is read from DB_URL.
if (!global.prisma) {
    const adapter = new PrismaPg({ connectionString: process.env.DB_URL });
    global.prisma = new PrismaClient({ adapter });
}
const prisma = global.prisma;

export { prisma };
