// Test child: answers after 300 ms with the same bytes; reports its start time.
process.on("message", (message) => {
    const started = Date.now();
    setTimeout(
        () =>
            process.send({
                ok: true,
                bytes: Buffer.from(message.buffer),
                started,
            }),
        300
    );
});
