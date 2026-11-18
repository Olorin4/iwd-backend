import {
    assertDisposableDatabase,
    cleanTables,
    serializeSuite,
} from "./harness";

describe("integration harness database guard", () => {
    const original = process.env.DB_URL;
    afterEach(() => {
        process.env.DB_URL = original;
    });

    it("accepts only databases whose name ends in _test or _scratch", () => {
        expect(
            assertDisposableDatabase(
                "postgresql://u:p@h:5432/iwd_onboarding_test"
            )
        ).toBe("iwd_onboarding_test");
        expect(
            assertDisposableDatabase("postgresql://u:p@h/iwd_scratch?schema=x")
        ).toBe("iwd_scratch");
        for (const url of [
            "postgresql://u:p@h:5432/iwd",
            "postgresql://u:p@h:5432/iwd_test_backup",
            "postgresql://u:p@h:5432/",
            "",
            undefined,
        ])
            expect(() => assertDisposableDatabase(url)).toThrow(/Refusing/);
    });

    it("cleanTables and serializeSuite refuse a production-like database", async () => {
        process.env.DB_URL = "postgresql://u:p@db.example:5432/iwd_production";
        const db = { $executeRawUnsafe: jest.fn() };
        await expect(cleanTables(db)).rejects.toThrow(/Refusing/);
        expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(() => serializeSuite()).toThrow(/Refusing/);
    });
});
