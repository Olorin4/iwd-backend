/* global document, location, XMLHttpRequest */
document.documentElement.classList.add("js");
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

const MAX_PHOTOS = 10;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

// Upload rows: "Choose file" (one PDF, or photos) and, on phones, "Take
// photos". Photos from either collect as pages with thumbnails, one or
// several at a time; the server combines them into one PDF.
const MIXED = "Send either one PDF or photos of the pages, not both.";
const isPhoto = (file) =>
    file.type.startsWith("image/") ||
    /\.(heic|heif|jpe?g|png)$/i.test(file.name);
document.querySelectorAll("form[data-upload]").forEach((form) => {
    const button = form.querySelector("button[type=submit]");
    const bar = form.querySelector("progress");
    const list = form.querySelector(".photo-list");
    const camera = form.querySelector(".take-photos input");
    const chooser = form.querySelector(".choose input");
    const addPage = form.querySelector(".add-page");
    const photos = [];
    // The chosen non-photo file (a PDF); photos move into the page list.
    let single = [];

    const chosenNote = document.createElement("p");
    chosenNote.className = "chosen";
    chosenNote.setAttribute("role", "status");
    chosenNote.hidden = true;
    form.querySelector(".upload-actions")?.after(chosenNote);
    const label = () => {
        const picked = single.length;
        chosenNote.hidden = picked === 0;
        chosenNote.textContent =
            picked === 1
                ? `Chosen: ${single[0].name}`
                : `${picked} files chosen`;
        const count = photos.length + picked;
        button.textContent =
            photos.length > 0
                ? `Send ${count} page${count === 1 ? "" : "s"} as one PDF`
                : "Upload";
    };
    const render = () => {
        list.replaceChildren(
            ...photos.map((photo, index) => {
                const figure = document.createElement("figure");
                const image = document.createElement("img");
                image.src = photo.url;
                image.alt = "";
                // Browsers without HEIC support show the file name instead.
                image.addEventListener("error", () => {
                    const name = document.createElement("span");
                    name.className = "photo-name";
                    name.textContent = photo.file.name;
                    image.replaceWith(name);
                });
                const caption = document.createElement("figcaption");
                caption.textContent = `Page ${index + 1}`;
                const remove = document.createElement("button");
                remove.type = "button";
                remove.className = "remove";
                remove.textContent = "×";
                remove.setAttribute("aria-label", `Remove page ${index + 1}`);
                remove.addEventListener("click", () => {
                    URL.revokeObjectURL(photo.url);
                    photos.splice(index, 1);
                    render();
                });
                figure.append(image, caption, remove);
                return figure;
            })
        );
        list.hidden = photos.length === 0;
        if (camera) camera.disabled = photos.length >= MAX_PHOTOS;
        if (addPage)
            addPage.hidden = photos.length === 0 || photos.length >= MAX_PHOTOS;
        label();
    };
    camera?.addEventListener("change", () => {
        for (const file of camera.files)
            if (photos.length < MAX_PHOTOS)
                photos.push({ file, url: URL.createObjectURL(file) });
        camera.value = "";
        render();
    });
    chooser?.addEventListener("change", () => {
        const files = [...(chooser.files ?? [])];
        chooser.value = "";
        form.querySelector("[role=alert]")?.remove();
        if (files.length > 0 && files.every(isPhoto)) {
            single = [];
            for (const file of files)
                if (photos.length < MAX_PHOTOS)
                    photos.push({ file, url: URL.createObjectURL(file) });
            render();
            return;
        }
        if (photos.length > 0 && files.length > 0) {
            failedNote(form, MIXED);
            return;
        }
        single = files;
        label();
    });
    addPage?.addEventListener("click", () => chooser?.click());

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const payload = new FormData();
        payload.set("csrf", form.elements.csrf.value);
        for (const file of single) payload.append("file", file);
        for (const photo of photos) payload.append("file", photo.file);
        if (![...payload.getAll("file")].length) {
            failedNote(form, "Choose a file or take a photo first.");
            return;
        }
        const total = [...payload.getAll("file")].reduce(
            (sum, file) => sum + file.size,
            0
        );
        if (total > MAX_TOTAL_BYTES) {
            failedNote(
                form,
                "Together these photos are over 15 MB — send fewer pages or upload a PDF."
            );
            return;
        }
        const request = new XMLHttpRequest();
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
            failedNote(form, "Upload failed. Try again.");
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

function failedNote(form, text) {
    let note = form.querySelector("[role=alert]");
    if (!note) {
        note = document.createElement("p");
        note.setAttribute("role", "alert");
        form.append(note);
    }
    note.textContent = text;
}

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
