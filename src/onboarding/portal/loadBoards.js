import { escapeHtml } from "../../emailService.js";

const safe = (value) => escapeHtml(String(value ?? ""));
const BOARD_NAMES = { DAT_ONE: "DAT One", TRUCKSTOP: "Truckstop" };
const LINK = 'target="_blank" rel="noopener noreferrer"';

export const boardName = (board, otherName) =>
    board === "OTHER" ? otherName || "your load board" : BOARD_NAMES[board];

export const joinNames = (names) =>
    names.length > 1
        ? names.slice(0, -1).join(", ") + " and " + names.at(-1)
        : (names[0] ?? "");

// One "Added" button per board. Plain forms: they work without JavaScript.
function addedButton({ base, csrf, board, label, reported, other = false }) {
    if (reported) return `<p class="state success">Added ✓</p>`;
    return `<form class="added" method="post" action="${base}/load-board">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="board" value="${board}">
${other ? '<label for="other-board">Board name</label><input id="other-board" name="other" maxlength="100" required>' : ""}
<button type="submit" aria-label="${safe(label)}">Added</button></form>`;
}

/**
 * Portal step ④ before Iron Wing confirms access. base and csrf arrive
 * escaped; dispatcher is { name, email } or null; item is LOAD_BOARD_ACCESS.
 */
export function loadBoardGuide({ base, csrf, dispatcher, item, justAdded }) {
    const reported = item?.reported ?? [];
    const who = dispatcher
        ? `<strong>${safe(dispatcher.name)}</strong> (${safe(dispatcher.email)})`
        : "your Iron Wing dispatcher";
    const outcome = reported.length
        ? `<p class="notice${justAdded ? " added-now" : ""}" role="status">✓ You added a seat on ${safe(
              joinNames(reported.map((b) => boardName(b, item.reported_note)))
          )}${dispatcher ? ` for ${safe(dispatcher.name)}` : ""}. Iron Wing will check access and confirm it here.</p>`
        : "";
    const contact = dispatcher
        ? `<p class="dispatcher">Your Iron Wing dispatcher: <strong>${safe(dispatcher.name)}</strong> · <a href="mailto:${safe(dispatcher.email)}">${safe(dispatcher.email)}</a></p>`
        : `<p class="dispatcher">Your dispatcher’s name and email will appear here.</p>`;
    return `<div id="load-boards">${outcome}
<p>Set up at least one load board: DAT One, Truckstop or another board you use. You can add more than one.</p>
${contact}
<p>Add a separate seat for ${who} so they set up their own login. Keep passwords and verification codes private. When the seat is in place, press <strong>Added</strong>.</p>
<div class="load-boards">
    <details>
        <summary>DAT One${reported.includes("DAT_ONE") ? " ✓" : ""}</summary>
        <ol>
            <li>Sign in as the carrier account admin at <a href="https://account.dat.com/" ${LINK}>DAT Account</a>.</li>
            <li>If you need another seat, open <strong>Subscriptions</strong>, select <strong>+ ADD SEATS</strong>, add one seat and review the price and agreement before submitting. Use an available seat if you already have one.</li>
            <li>Go to <strong>User Management</strong> → <strong>Create a New User</strong>. Enter ${who}, select the DAT One seat under <strong>Seat Assignments</strong>, and choose <strong>Create User</strong>.</li>
            <li>DAT emails your dispatcher a link to set their own password.</li>
        </ol>
        <p>If the seat option is missing, <a href="https://www.dat.com/support" ${LINK}>contact DAT support</a> for dispatcher access. <a href="https://one.support.dat.com/en/account-billing-84e74143/user-management-f41a4be0/add-a-new-user-and-purchase-a-new-seat-0c787870" ${LINK}>DAT guide with screenshots</a></p>
        ${addedButton({ base, csrf, board: "DAT_ONE", label: "I added a seat on DAT One", reported: reported.includes("DAT_ONE") })}
    </details>
    <details>
        <summary>Truckstop${reported.includes("TRUCKSTOP") ? " ✓" : ""}</summary>
        <ol>
            <li>Sign in as the account admin at <a href="https://truckstop.com/login/" ${LINK}>Truckstop</a>. Open the menu next to your name (expand the side menu if needed), then select <strong>Subscriptions &amp; Users</strong> → <strong>Manage Users</strong>.</li>
            <li>Select <strong>Add New User</strong>. Enter ${who}, then select <strong>Add User</strong>. Leave Account Administrator off.</li>
            <li>Open the new user’s profile, select <strong>Licenses</strong>, check the Load Board license and select <strong>Done</strong>. If you have no available license, <a href="https://truckstop.com/contact-us/" ${LINK}>ask Truckstop support</a> to add one for your dispatcher.</li>
        </ol>
        <p><a href="https://community.truckstop.com/s/article/Account-Management-Tool" ${LINK}>Truckstop guide with screenshots</a></p>
        ${addedButton({ base, csrf, board: "TRUCKSTOP", label: "I added a seat on Truckstop", reported: reported.includes("TRUCKSTOP") })}
    </details>
    <details>
        <summary>Another load board${reported.includes("OTHER") ? " ✓" : ""}</summary>
        <p>Add a seat for ${who} the same way, then tell us which board it is.</p>
        ${addedButton({ base, csrf, board: "OTHER", label: "I added a seat on another load board", reported: reported.includes("OTHER"), other: true })}
    </details>
</div>
<p>If you don’t have a load board yet, ask us which one to set up.</p></div>`;
}
