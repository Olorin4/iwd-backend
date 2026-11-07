import { captureConversion, shutdownPosthog } from "../src/posthogServer";

const ORIGINAL_TOKEN = process.env.POSTHOG_PROJECT_TOKEN;

describe("captureConversion", () => {
    let client;
    beforeEach(() => {
        client = { capture: jest.fn(), shutdown: jest.fn() };
        process.env.POSTHOG_PROJECT_TOKEN = "phc_test_token";
    });
    afterEach(() => {
        if (ORIGINAL_TOKEN === undefined) {
            delete process.env.POSTHOG_PROJECT_TOKEN;
        } else {
            process.env.POSTHOG_PROJECT_TOKEN = ORIGINAL_TOKEN;
        }
    });

    it("captures with the email as distinctId and $set", () => {
        captureConversion(
            {
                event: "lead_signed_up",
                identityEmail: "a@b.co",
                posthogDistinctId: null,
                outreachRef: null,
                properties: { form: "sign_up", source: "server" },
            },
            { client }
        );
        expect(client.capture).toHaveBeenCalledTimes(1);
        expect(client.capture).toHaveBeenCalledWith({
            distinctId: "a@b.co",
            event: "lead_signed_up",
            properties: {
                form: "sign_up",
                source: "server",
                $set: { email: "a@b.co" },
            },
        });
    });

    it("merges the anonymous ID first", () => {
        captureConversion(
            {
                event: "lead_signed_up",
                identityEmail: "a@b.co",
                posthogDistinctId: "anon-1",
                properties: { form: "sign_up" },
            },
            { client }
        );
        expect(client.capture).toHaveBeenCalledTimes(2);
        expect(client.capture.mock.calls[0][0]).toEqual({
            distinctId: "a@b.co",
            event: "$identify",
            properties: { $anon_distinct_id: "anon-1" },
        });
        expect(client.capture.mock.calls[1][0].event).toBe("lead_signed_up");
    });

    it("does not merge when the ID equals the email", () => {
        captureConversion(
            {
                event: "contact_requested",
                identityEmail: "a@b.co",
                posthogDistinctId: "a@b.co",
                properties: {},
            },
            { client }
        );
        expect(client.capture).toHaveBeenCalledTimes(1);
        expect(client.capture.mock.calls[0][0].event).toBe("contact_requested");
    });

    it("adds outreach_ref only when present", () => {
        captureConversion(
            {
                event: "lead_signed_up",
                identityEmail: "a@b.co",
                outreachRef: "abcdefghijkl",
                properties: {},
            },
            { client }
        );
        captureConversion(
            { event: "lead_signed_up", identityEmail: "a@b.co" },
            { client }
        );
        expect(client.capture.mock.calls[0][0].properties.outreach_ref).toBe(
            "abcdefghijkl"
        );
        expect(client.capture.mock.calls[1][0].properties).not.toHaveProperty(
            "outreach_ref"
        );
    });

    it("is a no-op without a token", () => {
        for (const value of [undefined, ""]) {
            if (value === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
            else process.env.POSTHOG_PROJECT_TOKEN = value;
            captureConversion(
                { event: "lead_signed_up", identityEmail: "a@b.co" },
                { client }
            );
        }
        expect(client.capture).not.toHaveBeenCalled();
    });

    it("is a no-op without an identity email", () => {
        for (const identityEmail of [null, undefined, ""]) {
            captureConversion(
                { event: "lead_signed_up", identityEmail },
                { client }
            );
        }
        expect(client.capture).not.toHaveBeenCalled();
    });
});

describe("shutdownPosthog", () => {
    it("resolves when no client was ever created", async () => {
        await expect(shutdownPosthog()).resolves.toBeUndefined();
    });
});
