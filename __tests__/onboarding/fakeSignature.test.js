import { createFakeSignatureProvider } from "../../src/onboarding/signature/fake";

const signers = [
    { id: "2", name: "Iron Wing", email: "iw@example.test" },
    { id: "1", name: "Carrier", email: "carrier@example.test" },
];

async function sentDocument() {
    const fake = createFakeSignatureProvider();
    const { id } = await fake.createEnvelope({ files: [] }, signers, {});
    await fake.send(id);
    return { fake, id };
}

it("tracks per-recipient signing; the document completes when all have signed", async () => {
    const { fake, id } = await sentDocument();
    expect(fake.documents.get(id).recipients).toEqual([
        { id: "2", status: "sent" },
        { id: "1", status: "sent" },
    ]);
    fake.sign(id, "2");
    expect(fake.documents.get(id).status).toBe("pending");
    expect(fake.documents.get(id).recipients[0].status).toBe("completed");
    fake.sign(id, "1");
    expect(fake.documents.get(id).status).toBe("completed");
    expect(() => fake.sign(id, "9")).toThrow("provider_http_404");
});

it("returns a fresh embedded signing URL per call for a known recipient", async () => {
    const { fake, id } = await sentDocument();
    const a = await fake.embeddedSigningUrl(id, "2");
    const b = await fake.embeddedSigningUrl(id, "2");
    expect(a).toMatch(/^https:\/\/fake-signwell\.example\.test\/embedded\//);
    expect(a).not.toBe(b);
    expect(await fake.embeddedSigningUrl(id, "9")).toBeNull();
    fake.failNext("embeddedSigningUrl", "reject");
    await expect(fake.embeddedSigningUrl(id, "2")).rejects.toMatchObject({
        code: "provider_http_422",
    });
});
