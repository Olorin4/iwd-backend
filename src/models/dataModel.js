// src/models/dataModel.js
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const DataModel = {
    getAllSignUpForms: async () => {
        try {
            const result = await prisma.signUpForm.findMany();
            console.log("SignUpForms Retrieved:", result);
            return result;
        } catch (error) {
            console.error("Database Error (getAllSignUpForms):", error);
            throw error;
        }
    },
    getAllContactSubmissions: async () => {
        try {
            const result = await prisma.contactSubmission.findMany();
            console.log("ContactSubmissions Retrieved:", result);
            return result;
        } catch (error) {
            console.error("Database Error (getAllContactSubmissions):", error);
            throw error;
        }
    },
};

export default DataModel;
