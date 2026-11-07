import { assertTestDatabase } from "../scripts/testDatabaseGuard";

describe("assertTestDatabase", () => {
    it("accepts a database whose name ends in _test", () => {
        expect(
            assertTestDatabase("postgresql://u:p@localhost:5432/iwd_test")
        ).toBe("iwd_test");
    });

    it("accepts a query string", () => {
        expect(
            assertTestDatabase("postgresql://localhost/iwd_test?schema=public")
        ).toBe("iwd_test");
    });

    it("rejects the production name", () => {
        expect(() =>
            assertTestDatabase(
                "postgresql://u:p@nk-homeserver:5432/iwd_database"
            )
        ).toThrow(/iwd_database/);
    });

    it("rejects names that merely contain _test", () => {
        expect(() =>
            assertTestDatabase("postgresql://u:p@localhost:5432/iwd_test_copy")
        ).toThrow(/iwd_test_copy/);
    });

    it.each([undefined, ""])("rejects unset (%p)", (value) => {
        expect(() => assertTestDatabase(value)).toThrow(/\(unset\)/);
    });
});
