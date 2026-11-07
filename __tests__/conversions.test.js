import { recordConversion } from "../src/conversions";
import { captureConversion } from "../src/posthogServer.js";
import { notifyOutreach } from "../src/outreachWebhook.js";
import { logger } from "../src/logging.js";

jest.mock("../src/logging.js", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../src/posthogServer.js", () => ({
    captureConversion: jest.fn(),
}));
jest.mock("../src/outreachWebhook.js", () => ({
    notifyOutreach: jest.fn(),
}));

const attribution = {
    outreachRef: "abcdefghijkl",
    posthogDistinctId: "anon-1",
};
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe("recordConversion", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        captureConversion.mockReturnValue(undefined);
        notifyOutreach.mockResolvedValue("sent");
    });
    afterEach(() => {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    });

    it.each([
        ["sign_up", "lead_signed_up", "primary"],
        ["contact", "contact_requested", "secondary"],
        ["newsletter", "newsletter_subscribed_server", "secondary"],
    ])("maps %s to %s (%s)", async (type, event, tier) => {
        await recordConversion({
            type,
            leadId: 7,
            identityEmail: "a@b.co",
            attribution,
            properties: {},
        });
        expect(captureConversion).toHaveBeenCalledTimes(1);
        const arg = captureConversion.mock.calls[0][0];
        expect(arg).toMatchObject({
            event,
            identityEmail: "a@b.co",
            posthogDistinctId: "anon-1",
            outreachRef: "abcdefghijkl",
        });
        expect(arg.properties).toMatchObject({
            form: type,
            source: "server",
            conversion_tier: tier,
            deployment_environment: "development",
            outreach_ref: "abcdefghijkl",
        });
        expect(notifyOutreach).toHaveBeenCalledWith({
            type,
            outreachRef: "abcdefghijkl",
            email: "a@b.co",
            leadId: 7,
        });
    });

    it("reports production only when NODE_ENV is production", async () => {
        process.env.NODE_ENV = "production";
        await recordConversion({
            type: "contact",
            leadId: 1,
            identityEmail: "a@b.co",
            attribution,
        });
        expect(
            captureConversion.mock.calls[0][0].properties.deployment_environment
        ).toBe("production");
    });

    it("omits outreach_ref when there is none", async () => {
        await recordConversion({
            type: "newsletter",
            leadId: 1,
            identityEmail: "a@b.co",
            attribution: { outreachRef: null, posthogDistinctId: null },
        });
        const arg = captureConversion.mock.calls[0][0];
        expect(arg.properties).not.toHaveProperty("outreach_ref");
        expect(notifyOutreach).toHaveBeenCalledWith(
            expect.objectContaining({ outreachRef: null })
        );
    });

    it("passes the allowed extra properties per type", async () => {
        await recordConversion({
            type: "sign_up",
            leadId: 1,
            identityEmail: "a@b.co",
            attribution,
            properties: {
                plan: "growth",
                fleet_size: "2-5",
                trailer_type: "dry_van",
                has_phone: true,
            },
        });
        await recordConversion({
            type: "contact",
            leadId: 2,
            identityEmail: "a@b.co",
            attribution,
            properties: { has_phone: false },
        });
        expect(captureConversion.mock.calls[0][0].properties).toMatchObject({
            plan: "growth",
            fleet_size: "2-5",
            trailer_type: "dry_van",
            has_phone: true,
        });
        expect(captureConversion.mock.calls[1][0].properties).toMatchObject({
            has_phone: false,
        });
    });

    it("never sends name, phone or message", async () => {
        const leaky = {
            name: "Jane Carrier",
            fullName: "Jane Carrier",
            phone: "555-123-4567",
            message: "Call me about my MC number",
            email: "a@b.co",
            company: "Acme Trucking",
            has_phone: true,
            plan: "growth",
        };
        for (const type of ["sign_up", "contact", "newsletter"]) {
            await recordConversion({
                type,
                leadId: 1,
                identityEmail: "a@b.co",
                attribution,
                properties: leaky,
            });
        }
        for (const [arg] of captureConversion.mock.calls) {
            const json = JSON.stringify(arg);
            expect(json).not.toContain("Jane");
            expect(json).not.toContain("555-123-4567");
            expect(json).not.toContain("Call me");
            expect(json).not.toContain("Acme");
            for (const key of [
                "name",
                "fullName",
                "phone",
                "message",
                "company",
            ]) {
                expect(arg.properties).not.toHaveProperty(key);
            }
        }
        // has_phone is allowed for sign_up and contact, not for newsletter.
        expect(captureConversion.mock.calls[0][0].properties.has_phone).toBe(
            true
        );
        expect(captureConversion.mock.calls[1][0].properties.has_phone).toBe(
            true
        );
        expect(
            captureConversion.mock.calls[2][0].properties
        ).not.toHaveProperty("has_phone");
        expect(
            captureConversion.mock.calls[1][0].properties
        ).not.toHaveProperty("plan");
    });

    it("swallows a throwing PostHog client", async () => {
        captureConversion.mockImplementation(() => {
            throw new Error("posthog down");
        });
        await expect(
            recordConversion({
                type: "sign_up",
                leadId: 3,
                identityEmail: "a@b.co",
                attribution,
            })
        ).resolves.toBeUndefined();
        expect(notifyOutreach).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalled();
    });

    it("swallows a rejected webhook", async () => {
        notifyOutreach.mockRejectedValue(new Error("boom"));
        await expect(
            recordConversion({
                type: "sign_up",
                leadId: 3,
                identityEmail: "a@b.co",
                attribution,
            })
        ).resolves.toBeUndefined();
        expect(captureConversion).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalled();
    });

    it("does not throw on missing attribution or an unknown type", async () => {
        await expect(
            recordConversion({
                type: "sign_up",
                leadId: 1,
                identityEmail: null,
            })
        ).resolves.toBeUndefined();
        await expect(
            recordConversion({ type: "bogus", leadId: 1 })
        ).resolves.toBeUndefined();
    });
});
