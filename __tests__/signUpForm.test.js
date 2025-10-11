import { signUpForm } from "../src/formsController";
import { prisma } from "../src/prismaClient";
import { validationResult } from "express-validator";

jest.mock("../src/prismaClient", () => ({
    prisma: { signUpForm: { create: jest.fn() } },
}));
jest.mock("express-validator", () => ({
    validationResult: jest.fn(),
    body: jest.fn(() => ({
        trim: jest.fn().mockReturnThis(),
        notEmpty: jest.fn().mockReturnThis(),
        withMessage: jest.fn().mockReturnThis(),
        isEmail: jest.fn().mockReturnThis(),
        escape: jest.fn().mockReturnThis(),
        normalizeEmail: jest.fn().mockReturnThis(),
    })),
}));
jest.mock("nodemailer", () => ({
    createTransport: jest.fn(() => ({
        sendMail: jest.fn().mockResolvedValue(true),
    })),
}));

describe("signUpForm", () => {
    let req, res;

    beforeEach(() => {
        req = {
            body: {
                first_name: "John",
                last_name: "Doe",
                email: "john.doe@example.com",
                phone: "1234567890",
                fleet_size: "5",
                trailer_type: "Flatbed",
                plan: "Premium",
            },
        };

        res = {status: jest.fn().mockReturnThis(), json: jest.fn()};
        validationResult.mockReturnValue({ isEmpty: () => true, array: () => [] });
    });

    it("should handle valid form submissions correctly", async () => {
        prisma.signUpForm.create.mockResolvedValue({ id: 1 });
        await signUpForm(req, res);
        expect(validationResult).toHaveBeenCalledWith(req);
        expect(prisma.signUpForm.create).toHaveBeenCalledWith({
            data: {
                first_name: "John",
                last_name: "Doe",
                email: "john.doe@example.com",
                phone: "1234567890",
                fleet_size: "5",
                trailer_type: "Flatbed",
                plan: "Premium",
                status: "pending",
            },
        });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            message: "Form submitted successfully!",
            id: 1,
        });
    });

    it("should return validation errors for invalid form submissions", async () => {
        validationResult.mockReturnValue({
            isEmpty: () => false,
            array: () => [{ msg: "Invalid email address." }],
        });
        await signUpForm(req, res);
        expect(validationResult).toHaveBeenCalledWith(req);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ errors: [{ msg: "Invalid email address." }] });
    });

    it("should handle database errors gracefully", async () => {
        prisma.signUpForm.create.mockRejectedValue(new Error("Database error"));
        await signUpForm(req, res);
        expect(validationResult).toHaveBeenCalledWith(req);
        expect(prisma.signUpForm.create).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "Database error" });
    });
});