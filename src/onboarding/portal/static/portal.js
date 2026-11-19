/* global document, location, XMLHttpRequest */
const menu = document.querySelector(".hamburger");
const navigation = document.querySelector("#site-navigation");
if (menu && navigation) {
    menu.closest("header").classList.add("menu-enhanced");
    const setMenuOpen = (open) => {
        navigation.classList.toggle("active", open);
        menu.setAttribute("aria-expanded", String(open));
    };
    menu.addEventListener("click", () => {
        setMenuOpen(menu.getAttribute("aria-expanded") !== "true");
    });
    menu.closest("header").addEventListener("keydown", (event) => {
        if (
            event.key === "Escape" &&
            menu.getAttribute("aria-expanded") === "true"
        ) {
            setMenuOpen(false);
            menu.focus();
        }
    });
}

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

for (const form of document.querySelectorAll("form[data-post]")) {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button");
        button.disabled = true;
        let message = "Could not save. Try again.";
        try {
            // With a no-referrer policy, some browsers send Origin: null on
            // form navigation. Same-origin fetch supplies the origin without
            // including the private page URL as a referrer.
            const response = await fetch(form.action, {
                method: "POST",
                body: new URLSearchParams(new FormData(form)),
            });
            if (response.redirected) {
                location.assign(response.url);
                return;
            }
            if (response.status === 410) {
                location.reload();
                return;
            }
            if (
                response.status === 422 &&
                form.hasAttribute("data-questionnaire")
            )
                message =
                    "Check the values and try again. Truck count must be between 1 and 500.";
        } catch {
            // Show the same feedback for a network failure.
        }
        let note = form.querySelector("[role=alert]");
        if (!note) {
            note = document.createElement("p");
            note.setAttribute("role", "alert");
            form.append(note);
        }
        note.textContent = message;
        button.disabled = false;
    });
}
