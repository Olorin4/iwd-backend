// Test child: never answers (simulates a decode that runs forever).
process.on("message", () => setInterval(() => {}, 1000));
