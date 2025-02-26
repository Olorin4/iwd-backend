// src/models/dataModel.js
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export const DataModel = {
    getAll: async () => {
        return await prisma.user.findMany();
    },
};
