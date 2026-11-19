// Test child: dies mid-conversion (simulates running out of memory).
process.on("message", () => process.exit(134));
