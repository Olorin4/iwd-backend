import { escapeHtml } from "../../emailService.js";
import { loadBoardStatuses } from "../readiness.js";

const safe = (value) => escapeHtml(String(value ?? ""));
const BOARD_NAMES = { DAT_ONE: "DAT One", TRUCKSTOP: "Truckstop" };
const LINK = 'target="_blank" rel="noopener noreferrer"';
const GUIDES = {
    DAT_ONE: [
        "https://one.support.dat.com/en/account-billing-84e74143/user-management-f41a4be0/add-a-new-user-and-purchase-a-new-seat-0c787870",
        "Official DAT guide ↗",
    ],
    TRUCKSTOP: [
        "https://community.truckstop.com/s/article/Account-Management-Tool",
        "Official Truckstop guide ↗",
    ],
};
const CHECK =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>';
const CLOCK =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';

export const boardName = (board, otherName) =>
    board === "OTHER" ? otherName || "your load board" : BOARD_NAMES[board];

export const joinNames = (names) =>
    names.length > 1
        ? names.slice(0, -1).join(", ") + " and " + names.at(-1)
        : (names[0] ?? "");

/** One-line summary for the step header. */
export function loadBoardSummary(item, dispatcher) {
    const statuses = loadBoardStatuses(item);
    const confirmed = statuses.filter((s) => s.state === "CONFIRMED");
    const waiting = statuses.filter((s) => s.state === "WAITING");
    if (confirmed.length)
        return `Confirmed: ${joinNames(confirmed.map((s) => boardName(s.board, s.name)))}`;
    if (waiting.length)
        return `${waiting.length} board${waiting.length > 1 ? "s" : ""} added · waiting for Iron Wing to confirm`;
    return dispatcher
        ? `For your dispatcher, ${dispatcher.name}`
        : "DAT One, Truckstop or another board";
}

// Plain form: works without JavaScript.
function addedButton({ base, csrf, board, label, other = false }) {
    return `<form class="added" method="post" action="${base}/load-board">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="board" value="${board}">
${other ? '<label for="other-board">Board name</label><input id="other-board" name="other" maxlength="100" required>' : ""}
<button type="submit">${safe(label)}</button></form>`;
}

function stateLine(status) {
    if (!status) return "";
    return status.state === "CONFIRMED"
        ? `<span class="board-state confirmed">Confirmed by Iron Wing</span>`
        : `<span class="board-state waiting">Added · waiting for Iron Wing to confirm</span>`;
}

function boardRow({ board, title, status, open, steps, base, csrf }) {
    const guide = GUIDES[board];
    const mark = !status
        ? '<span class="board-mark"></span>'
        : status.state === "CONFIRMED"
          ? `<span class="board-mark confirmed">${CHECK}</span>`
          : `<span class="board-mark waiting">${CLOCK}</span>`;
    return `<details class="board board-${status ? status.state.toLowerCase() : "new"}"${open ? " open" : ""}>
<summary>${mark}<span class="board-title">${safe(title)}${stateLine(status)}</span></summary>
<div class="board-body">${status ? "" : steps}
${guide ? `<p><a href="${guide[0]}" ${LINK}>${guide[1]}</a></p>` : ""}
${status ? "" : addedButton({ base, csrf, board, label: board === "OTHER" ? "Added" : `Added on ${title}`, other: board === "OTHER" })}</div></details>`;
}

/**
 * Portal step 4 body. base and csrf arrive escaped; dispatcher is
 * { name, email } or null; item is LOAD_BOARD_ACCESS. Each board shows not
 * added (guide + Added), added and waiting, or confirmed by Iron Wing.
 */
export function loadBoardGuide({ base, csrf, dispatcher, item, justAdded }) {
    const statuses = loadBoardStatuses(item);
    const statusOf = (board) => statuses.find((s) => s.board === board);
    const waiting = statuses.filter((s) => s.state === "WAITING");
    const who = dispatcher
        ? `<strong>${safe(dispatcher.name)}</strong> (${safe(dispatcher.email)})`
        : "your Iron Wing dispatcher";
    const outcome = waiting.length
        ? `<p class="notice waiting-note${justAdded ? " added-now" : ""}" role="status">You added a seat on ${safe(
              joinNames(waiting.map((s) => boardName(s.board, s.name)))
          )}${dispatcher ? ` for ${safe(dispatcher.name)}` : ""}. Waiting for Iron Wing to confirm access — it will show a green check here.</p>`
        : "";
    const contact = dispatcher
        ? `<div class="dispatcher"><span class="avatar" aria-hidden="true">${safe(
              dispatcher.name
                  .split(/\s+/)
                  .map((w) => w[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()
          )}</span><div><span class="fine">Your Iron Wing dispatcher</span><strong>${safe(dispatcher.name)}</strong><a href="mailto:${safe(dispatcher.email)}">${safe(dispatcher.email)}</a></div></div>`
        : `<p class="dispatcher">Your dispatcher’s name and email will appear here.</p>`;
    const datSteps = `<ol>
<li>Sign in as the carrier account admin at <a href="https://account.dat.com/" ${LINK}>DAT Account</a>.</li>
<li>If you need another seat, open <strong>Subscriptions</strong>, select <strong>+ ADD SEATS</strong>, add one seat and review the price and agreement before submitting. Use an available seat if you already have one.</li>
<li>Go to <strong>User Management</strong> → <strong>Create a New User</strong>. Enter ${who}, select the DAT One seat under <strong>Seat Assignments</strong>, and choose <strong>Create User</strong>.</li>
<li>DAT emails your dispatcher a link to set their own password.</li>
</ol>
<p>If the seat option is missing, <a href="https://www.dat.com/support" ${LINK}>contact DAT support</a> for dispatcher access.</p>`;
    const truckstopSteps = `<ol>
<li>Sign in as the account admin at <a href="https://truckstop.com/login/" ${LINK}>Truckstop</a>. Open the menu next to your name (expand the side menu if needed), then select <strong>Subscriptions &amp; Users</strong> → <strong>Manage Users</strong>.</li>
<li>Select <strong>Add New User</strong>. Enter ${who}, then select <strong>Add User</strong>. Leave Account Administrator off.</li>
<li>Open the new user’s profile, select <strong>Licenses</strong>, check the Load Board license and select <strong>Done</strong>. If you have no available license, <a href="https://truckstop.com/contact-us/" ${LINK}>ask Truckstop support</a> to add one for your dispatcher.</li>
</ol>`;
    const otherStatus = statusOf("OTHER");
    return `<div id="load-boards">${outcome}${contact}
<p>Set up at least one load board: DAT One, Truckstop or another board you use. You can add more than one. Add a separate seat for ${who} so they set up their own login. Keep passwords and verification codes private. When the seat is in place, press <strong>Added</strong>.</p>
<div class="boards">
${boardRow({ board: "DAT_ONE", title: "DAT One", status: statusOf("DAT_ONE"), open: false, steps: datSteps, base, csrf })}
${boardRow({ board: "TRUCKSTOP", title: "Truckstop", status: statusOf("TRUCKSTOP"), open: false, steps: truckstopSteps, base, csrf })}
${boardRow({ board: "OTHER", title: otherStatus?.name || "Another load board", status: otherStatus, open: false, steps: `<p>Add a seat for ${who} the same way, then tell us which board it is.</p>`, base, csrf })}
</div>
<p class="fine">If you don’t have a load board yet, ask us which one to set up.</p></div>`;
}
