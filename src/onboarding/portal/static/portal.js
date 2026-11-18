/* global document, location, XMLHttpRequest */
const portal = document.querySelector("[data-portal]");
let timer;
let deadline;

function beginPolling() {
    if (!portal) return;
    deadline = Date.now() + 120000;
    if (timer) return;
    timer = setInterval(async () => {
        if (Date.now() > deadline) {
            clearInterval(timer);
            timer = undefined;
            return;
        }
        try {
            const response = await fetch(portal.dataset.statusUrl, {
                cache: "no-store",
            });
            if (response.status === 410) {
                location.reload();
                return;
            }
            if (!response.ok) return;
            const status = await response.json();
            if (
                status.signature !== portal.dataset.signature ||
                status.payment !== portal.dataset.payment
            )
                location.reload();
        } catch {
            // A temporary connection issue will be retried on the next poll.
        }
    }, 5000);
}

document
    .querySelectorAll("[data-poll-link]")
    .forEach((link) => link.addEventListener("click", beginPolling));
if (portal?.dataset.poll === "true") beginPolling();

document.querySelectorAll("form[data-upload]").forEach((form) => {
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const button = form.querySelector("button");
        const bar = form.querySelector("progress");
        const request = new XMLHttpRequest();
        const payload = new FormData(form);
        button.disabled = true;
        bar.hidden = false;
        bar.removeAttribute("value");
        request.open("POST", form.action);
        request.upload.addEventListener("progress", (progress) => {
            if (progress.lengthComputable)
                bar.value = (progress.loaded / progress.total) * 100;
        });
        const failed = () => {
            button.disabled = false;
            bar.hidden = true;
            let note = form.querySelector("[role=alert]");
            if (!note) {
                note = document.createElement("p");
                note.setAttribute("role", "alert");
                form.append(note);
            }
            note.textContent = "Upload failed. Try again.";
        };
        request.addEventListener("error", failed);
        request.addEventListener("load", () => {
            if (request.status === 410) location.reload();
            else if (request.status === 200 && request.responseURL)
                location.assign(request.responseURL);
            else failed();
        });
        request.send(payload);
    });
});
