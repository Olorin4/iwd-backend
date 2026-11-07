import { signUpForm } from "../src/formsController";
import { prisma } from "../src/prismaClient";
import { validationResult } from "express-validator";
import { recordConversion } from "../src/conversions";

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
// Never send real PostHog events or Outreach webhooks from these tests.
jest.mock("../src/conversions", () => ({
    recordConversion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/logging", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock("nodemailer", () => ({
    createTransport: jest.fn(() => ({
        sendMail: jest.fn().mockResolvedValue(true),
    })),
}));

describe("signUpForm", () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            body: {
                firstName: "John",
                lastName: "Doe",
                email: "john.doe@example.com",
                phone: "1234567890",
                fleetSize: "5",
                trailerType: "Flatbed",
                plan: "Premium",
            },
        };

        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            locals: {
                identityEmail: "john.doe@example.com",
                attribution: { outreachRef: null, posthogDistinctId: null },
            },
        };
        recordConversion.mockResolvedValue(undefined);
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
        validationResult.mockReturnValue({
            isEmpty: () => true,
            array: () => [],
        });
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
                outreach_ref: null,
                posthog_distinct_id: null,
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
        expect(res.json).toHaveBeenCalledWith({
            errors: [{ msg: "Invalid email address." }],
        });
    });

    it("validation failure records nothing", async () => {
        validationResult.mockReturnValue({
            isEmpty: () => false,
            array: () => [{ msg: "Invalid email address." }],
        });
        await signUpForm(req, res);
        expect(prisma.signUpForm.create).not.toHaveBeenCalled();
        expect(recordConversion).not.toHaveBeenCalled();
    });

    it("sign-up stores outreach_ref and posthog_distinct_id", async () => {
        prisma.signUpForm.create.mockResolvedValue({ id: 7 });
        res.locals.attribution = {
            outreachRef: "abcdefghijk2",
            posthogDistinctId: "anon-123",
        };
        await signUpForm(req, res);
        expect(prisma.signUpForm.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                outreach_ref: "abcdefghijk2",
                posthog_distinct_id: "anon-123",
            }),
        });
    });

    it("sign-up calls recordConversion after responding", async () => {
        prisma.signUpForm.create.mockResolvedValue({ id: 7 });
        const attribution = {
            outreachRef: "abcdefghijk2",
            posthogDistinctId: "anon-123",
        };
        res.locals = { identityEmail: "John.Doe@example.com", attribution };
        // A conversion that never settles must not hold up the handler.
        recordConversion.mockReturnValue(new Promise(() => {}));

        await signUpForm(req, res);

        expect(recordConversion).toHaveBeenCalledTimes(1);
        expect(recordConversion).toHaveBeenCalledWith({
            type: "sign_up",
            leadId: 7,
            identityEmail: "John.Doe@example.com",
            attribution,
            properties: {
                plan: "Premium",
                fleet_size: 5,
                trailer_type: "Flatbed",
                has_phone: true,
            },
        });
        expect(res.json.mock.invocationCallOrder[0]).toBeLessThan(
            recordConversion.mock.invocationCallOrder[0]
        );
    });

    it("sends fleet_size null and has_phone false when not given", async () => {
        prisma.signUpForm.create.mockResolvedValue({ id: 8 });
        req.body.fleetSize = "lots";
        req.body.phone = "";
        await signUpForm(req, res);
        expect(recordConversion).toHaveBeenCalledWith(
            expect.objectContaining({
                properties: expect.objectContaining({
                    fleet_size: null,
                    has_phone: false,
                }),
            })
        );
    });

    it("a rejected recordConversion does not change the response", async () => {
        prisma.signUpForm.create.mockResolvedValue({ id: 9 });
        recordConversion.mockRejectedValue(new Error("posthog down"));
        await expect(signUpForm(req, res)).resolves.toBeUndefined();
        await new Promise((r) => setImmediate(r));
        expect(res.status).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith({
            message: "Form submitted successfully!",
            id: 9,
        });
    });

    it("should handle database errors gracefully", async () => {
        prisma.signUpForm.create.mockRejectedValue(new Error("Database error"));
        await signUpForm(req, res);
        expect(validationResult).toHaveBeenCalledWith(req);
        expect(prisma.signUpForm.create).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "Database error" });
        expect(recordConversion).not.toHaveBeenCalled();
    });
});
