// Unit tests must mock Prisma. Pin DB_URL to a host that cannot resolve (and a
// *_test name) before any test module loads, so a test that forgets the mock
// fails to connect instead of reaching a real database via .env or .env.test.
process.env.DB_URL =
    "postgresql://unit-tests-must-mock-prisma.invalid:5432/unit_tests_must_mock_prisma_test";
