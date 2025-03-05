/* src/models/prismaClient.js initializes a global database connection that is used throughout the application. */

import { PrismaClient } from "@prisma/client";

// Ensure only one instance of PrismaClient is created and reused
let prisma;
if (!global.prisma) {
    global.prisma = new PrismaClient();
}
prisma = global.prisma;
export { prisma };
