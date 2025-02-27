/* src/models/dataModel.js Manages all database operations for the 
application. It contains functions to retrieve data from the database. 
The getAllSignUpForms function retrieves all sign-up forms from the
database, while the getAllContactSubmissions function retrieves all
contact submissions. These functions are used in the getAllSignUpForms 
and getAllContactSubmissions routes in the router.js file. */

import { PrismaClient } from "@prisma/client";

// Ensure only one instance of PrismaClient is created and reused
let prisma;
if (!global.prisma) {
    global.prisma = new PrismaClient();
}
prisma = global.prisma;

export async function getAllSignUpForms(limit = 50, offset = 0) {
    try {
        const result = await prisma.signUpForm.findMany({
            take: limit,
            skip: offset,
        });
        console.log(`SignUpForms Retrieved: ${result.length} records`);
        return result;
    } catch (error) {
        console.error("Database Error (getAllSignUpForms):", error);
        throw error;
    }
}

export async function getAllContactSubmissions(limit = 50, offset = 0) {
    try {
        const result = await prisma.contactSubmission.findMany({
            take: limit,
            skip: offset,
        });
        console.log(`ContactSubmissions Retrieved: ${result.length} records`);
        return result;
    } catch (error) {
        console.error("Database Error (getAllContactSubmissions):", error);
        throw error;
    }
}
