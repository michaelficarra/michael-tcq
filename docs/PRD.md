# TCQ — Product Requirements Document

TCQ is a real-time web application for managing a structured discussion queue during agenda-driven committee meetings. It enables chairs to control the flow of discussion and participants to queue themselves to speak on topics.

## User Roles

### Participants

All authenticated users are participants. They can:

- Join an existing meeting by its meeting ID
- View the agenda and current meeting state (current agenda item, current speaker, queue)
- Add themselves to the speaker queue with a topic description and entry type
- Edit their own queue entries
- Remove their own entries from the queue
- React during a poll

### Chairs

The meeting creator is the initial chair. In addition to all participant capabilities, chairs can:

- Create meetings
- Edit the list of chairs (add or remove others, but cannot remove themselves)
- Add, edit, delete, and reorder agenda items
- Start the meeting / advance to the next agenda item
- Advance to the next speaker
- Edit, reorder, and remove any entry in the speaker queue
- Close and reopen the queue to prevent or allow new entries from participants
- Initiate, configure, and stop polls
- Copy poll results to the clipboard

### Admins

Admins are designated by GitHub username via server configuration. In addition to all participant capabilities, admins can:

- See an additional **Admin** tab on the home page (between **Join Meeting** and **Help**) that is hidden from non-admin users. It contains the active-meetings list and the diagnostics panel described below.
- View a list of all active meetings on the Admin tab, showing each meeting's ID (linked to that meeting), creation time, distinct participant count, and last connection time. The creation and last-connection times render as relative durations (e.g. "3 hr ago") that update live, with the full ISO timestamp shown on hover. While at least one client is currently connected, the last-connection cell instead reads `now (N)`, where N is the current active-connection count (inclusive of every connected socket, admin or otherwise).
- View a diagnostics panel on the Admin tab (alongside the meetings list) summarising server health: wall-clock uptime, active CPU time (which lags uptime when the container is throttled or paused, e.g. on Cloud Run), Node version, deployed git SHA, memory usage, aggregate active meetings / participants / live connections, the total connected Socket.IO clients, cumulative HTTP traffic since process start (total responses, 4xx, 5xx, and overall error rate), persistence health (current dirty-meeting backlog plus the timestamps of the last sync that actually wrote a meeting and of the last failed sync — idle sweeps that find nothing to write don't refresh the success timestamp — with the failure message when present), and the most recent ERROR or CRITICAL log entries (with a count of how many have been recorded since the server started). The panel refreshes every 10 seconds. All counters and recent-error history are process-local and reset on restart.
- Soft-delete any meeting (with a confirmation dialogue). A soft-deleted meeting is no longer joinable — attempting to join (by URL or otherwise) responds as if the meeting did not exist, any clients currently connected to the meeting are disconnected, and the meeting is hidden from every user's **My Meetings** panel. Soft-deleted meetings remain visible on the admin active-meetings list, rendered with a strikethrough and with the meeting ID no longer linked. A soft-deleted meeting is still subject to the normal 90-day inactivity retention, so it is eventually purged outright.
- Restore a soft-deleted meeting. The Delete button on each admin row is replaced by a **Restore** button on rows in the soft-deleted state; clicking it returns the meeting to the live set immediately, with no confirmation prompt. Restored meetings become joinable again and reappear in associated users' **My Meetings**.
- Edit the chair list for any meeting, even if they are not a chair themselves.
- Remove themselves from the chair list, including when they are the last chair (allowing an empty chair list).

The distinct participant count reflects how many unique users have joined the meeting via a socket connection — it is incremented on first join and is not affected by reconnections, additional tabs, or being added to an agenda item without connecting. Admins who join a meeting also count as participants.

### Premium-tier users

Premium-tier users are designated by GitHub username via the **Premium Users** section of the Admin tab on the home page. Admins add or remove premium users at runtime; changes take effect immediately for every connected participant of any meeting where the affected user is present — the premium badge appears or disappears next to their name and their queue-entry glow turns on or off without a refresh. The premium list is persisted server-side and survives restarts.

The tier is a user-visible status that may gate additional features over time. Two initial visual treatments mark a premium user:

- A verification-style badge is shown after the user's display name **everywhere their name appears** (queue entries, agenda chairs and presenters, current speaker, current topic, meeting log, user menu, etc.). The badge gently pulses in a heartbeat rhythm (disabled when the viewer prefers reduced motion) and surfaces a `TCQ Premium™` tooltip on hover.
- Queue entries belonging to a premium user have a soft animated colour glow behind the row.

Both treatments are visible to every participant in the meeting, not only to the premium user themselves. Premium-tier users have no additional permissions or capabilities beyond a regular participant. Premium status is independent of the admin role: a user can be either, both, or neither.

## Authentication

Users authenticate via GitHub OAuth. Their GitHub display name, username, and organisation are used as their identity within the application. Unauthenticated users see a login page with a "Log in with GitHub" button. When an unauthenticated user follows a deep link to a specific page (e.g. a meeting URL), completing login returns them to that page rather than the home page.

When GitHub OAuth is not configured, the server runs in mock auth mode with a fake user, allowing development without creating an OAuth App. In mock auth mode, a dev user-switcher in the navigation bar allows switching between different mock identities.

Logging in, logging out, or switching mock users in one browser tab is reflected in all other open tabs of the same browser without losing in-progress edits (form drafts, scroll position, open meeting view).

## Home Page

The home page shows two cards side by side:

- **Join Meeting** — a text input for the meeting ID and a "Join" button. Validates that the meeting exists before navigating to it.
- **New Meeting** — a "Start a New Meeting" button that creates a meeting with the current user as the sole chair and redirects to it. Additional chairs can be added from the Agenda tab.

Below the two cards, a **My Meetings** panel lists every meeting the current user is associated with — as a chair, an agenda-item presenter, a queue speaker, or anyone who has joined via socket. Each row shows the meeting ID (linked to that meeting) and the meeting's last activity: `now (N active)` (where N is the current count of connected sockets) while at least one client is connected, otherwise a relative duration since the last connection (e.g. "5 min ago"), or `never` for meetings nobody has ever joined. In-progress meetings are listed first, then idle meetings most-recently-active first. The panel is hidden for users with no associated meetings, and refreshes every 10 seconds while the home page is open.

## Meetings

### Creating a Meeting

An authenticated user clicks "Start a New Meeting" to create a meeting with themselves as the sole initial chair. The system generates a meeting ID consisting of a short sequence of memorable, easily distinguished words. After creation, the user is taken directly to the new meeting's Agenda tab so they can immediately add agenda items and additional chairs.

### Joining a Meeting

Any authenticated user can join a meeting by entering its meeting ID or by navigating to the meeting's permalink (which includes the meeting ID in the URL). Upon joining, the user receives the full current meeting state and all subsequent real-time updates.

If a user navigates to a non-existent meeting, a clear error page is shown with a link back to the home page.

## Meeting Flow

1. A chair creates a meeting and shares the meeting ID with participants.
2. Participants join.
3. The chair clicks **Start Meeting** to advance to the first agenda item. If the agenda item has any presenters, its first presenter automatically becomes the current speaker; otherwise the floor is left open until someone enters the queue.
4. Participants enter the queue to discuss the item.
5. The chair advances through the queue.
6. When discussion on an agenda item is complete, the chair clicks **Next Agenda Item**. A confirmation dialogue always opens (regardless of queue state) so the chair can record a free-form conclusion for the outgoing item; if entries remain in the queue, the dialogue also warns that they will be cleared and shows the entry count. The conclusion textarea is focused automatically when the dialogue opens, and Ctrl/Cmd+Enter inside it submits the dialogue (equivalent to clicking **Advance**) so chairs can advance without leaving the keyboard. On confirming, the next item's first presenter (if any) becomes the current speaker, the queue and current topic are cleared, the conclusion is saved on the outgoing item, and a snapshot of the conclusion appears in the meeting log for that "Finished" entry. If the next item has no presenters, the floor is left open and no current speaker is set. On the final agenda item the button is relabelled **Conclude meeting** (same dialogue, same conclusion textarea); confirming advances past the final item so a conclusion can still be recorded for it and the meeting enters a "concluded" state — no current agenda item, but distinct from the pre-start state. The queue view shows "Meeting concluded — add a new agenda item to continue." Adding a new agenda item while in the concluded state auto-activates it (no separate Start Meeting click needed); adding a session header does not — sessions are never the current item.
7. This repeats until the agenda is exhausted.

Before the meeting is started, the queue view displays "Waiting for the meeting to start..." with a **Start Meeting** button (visible to chairs). On every agenda item the chair sees an advance button; it reads **Next Agenda Item** when more items remain and **Conclude meeting** when on the final item.

## Navigation

The meeting view has four tabs:

- **Agenda** — displays the chairs list, the ordered list of agenda items with management controls for chairs, and the new agenda item form.
- **Queue** — displays the current agenda item (with poll controls), current topic, current speaker (with Next Speaker button), speaker entry controls, and the speaker queue.
- **Log** — displays a reverse-chronological timeline of meeting events (agenda changes, speaker topics, polls).
- **Help** — explains how to use TCQ, with separate participant and chair sections. The participant section covers joining a meeting, reading the agenda, the speaker queue and its entry types, polls, the meeting log and export, presentation mode, and keyboard shortcuts. The chair section adds: creating a meeting, managing chairs and agenda items (including agenda import and grouping items into sessions), running the meeting (Start Meeting, Next Speaker, Next Agenda Item), copying and restoring the queue, closing and reopening the queue, and running polls. The chair section is shown to chairs in a meeting and to everyone on the home page.

The active tab is indicated with a teal underline. A top navigation bar shows the TCQ logo and branding, the tab toggles, and the user menu (user badge and a hamburger menu button in OAuth mode, or a clickable user badge with user-switcher form alongside the hamburger menu in mock auth mode). The hamburger menu opens a dropdown with Preferences, Report an issue, and Log out entries; the Report an issue entry opens the project's GitHub repository in a new tab. Clicking anywhere outside the dropdown dismisses it. The Help tab is also available on the home page.

The application's dialogs (preferences, the keyboard-shortcuts reference, the agenda-advance confirmation, poll setup, and admin delete-confirmation) are modal: while one is open keyboard focus is trapped inside it, and it can be dismissed by pressing Esc, clicking outside it, the platform back gesture, or its own close/cancel control, with focus returning to whatever opened it. The sole exception is the active-poll modal (see Polls), which is intentionally non-dismissable.

The active tab is reflected in the URL as a hash fragment (`#queue`, `#agenda`, `#log`, `#help`). Switching tabs pushes a new browser-history entry, so the back button returns to the previously viewed tab rather than leaving the meeting. The browser back/forward buttons update the active tab in place without pushing further entries. An empty or unrecognised hash resolves to the Queue tab.

Any link that points to a destination outside the application — whether it appears in a user-generated markdown field (agenda item names, queue topics, conclusions, session names, poll topics) or in the application chrome itself (e.g. the hamburger menu's Report an issue entry) — opens in a new tab/window and displays a small northeast-facing arrow indicator next to the link text so users can tell, before clicking, that the link leaves TCQ.

## Agenda

The agenda is an ordered list of entries. Most entries are **agenda items**; interleaved among them chairs may also add **session headers** that group a contiguous run of items by capacity (see "Sessions" below). Each agenda item has:

- **Name** — the title of the item
- **Presenters** — zero or more GitHub users who will introduce/present it (each shown with their GitHub avatar). When the meeting advances to the item, the first presenter, if any, becomes the current speaker; if the item has no presenters, advancement leaves the floor open and no current speaker is set until someone enters the queue.
- **Duration** (optional) — a duration in minutes. Before an item is reached, this is an estimate of how long it will take; once the chair advances past the item, the estimate is automatically replaced with the actual elapsed time, rounded up to the nearest minute, so the agenda's estimates self-correct as the meeting progresses. The agenda list labels the value as "Estimate" for current and future items and as "Duration" for past items.
- **Conclusion** (optional) — free-form text recording what was decided or concluded for the item. It is set or edited only via the Next Agenda Item confirmation dialogue (see "Advancing the Agenda" below); it is shown in the meeting log under the corresponding "Finished" entry and underneath the item in the agenda list once the item has been advanced past. If an item that already has a conclusion becomes the current item again (e.g. via reorder), the dialogue's textarea is pre-populated with the previously stored conclusion so the chair can edit or replace it.

### Chair Management

The Agenda tab displays the list of chairs inline next to the "Chairs" heading. Each chair is shown as a pill-shaped badge with their avatar and name. Chairs and admins can manage the list directly:

- **Add** — a "+" icon to the right of the chair pills opens an inline username input. The input shows an autocomplete dropdown of fuzzy matches as the user types (see "Username Autocomplete" below). When OAuth is configured, new usernames are validated against the GitHub API.
- **Remove** — an "×" icon on each chair's pill removes them after a confirmation dialogue.

For regular chairs: they cannot remove themselves from the list (no remove icon is shown on their own pill), and at least one chair must remain. Admins bypass both restrictions — they can remove any chair, including themselves, even if it leaves the chair list empty.

### Agenda Management (Chair Only)

- **Add** — Create a new agenda item by specifying a name, presenters (zero or more GitHub usernames as a chip input — type a name and press Enter or comma to add it as a token; tokens can be removed individually, and each token shows the user's GitHub avatar alongside their login), and an optional time estimate. The presenters input shows an autocomplete dropdown of fuzzy matches as the user types (see "Username Autocomplete" below); selecting a suggestion adds it as a token, but typing a non-matching name and pressing Enter still adds it (so presenters without a GitHub account can be recorded). The form fields are: Agenda Item Name (flexible width), Presenters (starts empty — the chair adds presenters explicitly, and the form is happy to submit with none), and Estimate in minutes.
- **Import** — When the agenda is empty, chairs can import an agenda from a TC39 agenda URL (a markdown document on the tc39/agendas GitHub repository). The server fetches the document, parses numbered list items and markdown tables to extract item names, presenters, and estimated durations (TC39 agendas still label this column "timebox"; the parser maps it to the `duration` field). A presenter column or parenthetical may list multiple names separated by `,`, `&`, or whitespace-bounded `and` (or any mix), each becoming a distinct presenter; bare markdown links inside the parenthetical (slides/notes metadata) are ignored. If a row has no presenter information, the imported item is created with no presenters (the chair can edit one in afterwards). A numbered list item is imported only when its trailing parenthetical contains a duration (e.g. `(15m, Samina Husain)`, `(Chair, 10m)`, `(5m)`); a trailing parenthetical with no time (e.g. `(Jordan Harband)`, `(in insertion order)`) is treated as decorative metadata and the item is skipped, as are items with no trailing parenthetical at all. The parser still descends into any nested ordered list — children with their own timed parentheticals are imported as separate agenda items, and each child's name is prefixed with the chain of ancestor item names joined by `: ` (so "Project Editors' Reports → ECMA262 Status Updates (10m)" imports as `Project Editors' Reports: ECMA262 Status Updates`). Markdown formatting in item names is preserved. Each parsed presenter name is run through the same directory the username autocomplete uses, restricted to the meeting-users and org-members tiers (the global GitHub search tier is intentionally skipped); when a name yields exactly one match, the imported item is bound to that real user, otherwise the name is recorded as-is without a GitHub association.
- **Edit** — Inline edit of an existing agenda item's name, presenters, and estimate/duration. The presenters field is the same chip combobox used by the New Agenda Item form, pre-populated with the item's existing presenter list (each as a chip that can be removed individually).
- **Delete** — Remove an agenda item. The current agenda item (the one actively being discussed) cannot be deleted — its delete control is hidden, and the server rejects the request if it arrives anyway. The chair must advance to the next agenda item first.
- **Reorder** — Drag-and-drop to rearrange agenda items. Each item exposes a drag handle (the same ⠿ glyph used by queue entries) at the left of the row; the rest of the row is not draggable. The handle remains active while an item is being edited inline, so the chair can reorder a row mid-edit without losing in-progress changes.

### Username Autocomplete

Every place the app accepts a GitHub username — the agenda form's presenters input, the inline agenda-item edit form, the chair-add input, and the dev user-switcher — is backed by a fuzzy-match autocomplete dropdown. The dropdown surfaces three deduped tiers in priority order:

1. Users already known to the current meeting. This is anyone the meeting state has ever recorded a user record for, and once recorded a user is never removed. Specifically it covers:
   - **Anyone who has connected to the meeting via a socket** (from the moment they join, even if they only sit and watch and never grab the floor or are referenced anywhere else).
   - **Every chair ever set on the meeting** — current chairs and chairs who have since been removed.
   - **Every presenter ever named on an agenda item** — current items, items whose presenter list has since been edited, and deleted items.
   - **Every queue entrant ever** — current waiting speakers and speakers whose entries have already been popped or removed.
2. Public members of any GitHub organisation the searcher publicly belongs to. The app uses only the `read:user` OAuth scope, so it sees only the orgs the searcher has chosen to make public on GitHub and only the public members within those orgs — concealed memberships are deliberately invisible to TCQ.
3. Global GitHub user-search results, fetched on the searcher's behalf using their OAuth token. Only consulted when tiers 1 and 2 produce fewer matches than the dropdown holds.

Matching is case-insensitive, whitespace-insensitive, _and_ diacritic-insensitive, and runs against each user's GitHub login, display name, and `company` field. Both the typed query and the candidate fields are lowercased, NFD-normalised with combining diacritics stripped, and have all whitespace removed before comparison — so a typist can enter "Samina Husein" and match the camel-case login "SaminaHusein", or type "Jose Perez" and match the stored name "José Pérez" (in either direction). Within each tier, prefix matches always rank above substring matches, which always rank above subsequence ("fuzzy") matches; within a single match class, login matches outweigh name matches, which outweigh company matches. Each suggestion row shows the avatar, login, optional display name, and optional company plus an "in meeting" / "org" tier badge.

**Interaction.** The dropdown is a _suggestion_ layer, not a constraint:

- Typing a name that matches no suggestion and pressing Enter (or comma, in the multi-select presenters chip input) still commits the typed text as a token — so presenters who don't have a GitHub account can still be recorded.
- The dropdown stays hidden until the user has typed at least one character. Focusing an empty input (or one whose value is pre-filled, such as the dev user-switcher pre-populated with the current username) does not open the dropdown or fire any network request — the user must edit the input first.
- Once results arrive, no entry is highlighted by default. Pressing Enter commits the typed text. Pressing ArrowDown moves focus into the dropdown and highlights the first entry; subsequent ArrowDown / ArrowUp move through the list, and Enter commits the highlighted suggestion. ArrowUp past the first entry releases focus back to "nothing highlighted" so a follow-up Enter commits the typed text again.
- Suggestions are only committed on a primary-button click; right-click and middle-click pass through to default browser behaviour without selecting a user.
- Queries are debounced — no fetch fires until ~250 ms of typing inactivity.
- The highlighted suggestion uses the same orange palette as the current-agenda-item highlight on the Agenda tab, so the "selected" affordance is consistent across the app and reads correctly in both light and dark modes.
- The dropdown is positioned to escape any clipping ancestor and stays inside the viewport. It prefers placement directly below the input, flips above when there's not enough room below, shifts horizontally to avoid overflowing the right edge, and caps its own height (with internal scrolling) when even the flipped placement won't fit.

In the multi-select chip variant (agenda presenters), each committed token is rendered as a pill containing the user's GitHub avatar and login, with an inline button to remove it; pressing Backspace into an empty input removes the most recently added chip.

In local development with mock auth, the dropdown is backed by a hardcoded seed list of TC39 public members (no network access), so the feature works offline.

### Markdown in Item Names and Queue Topics

Agenda item names, queue entry topics, session names, agenda item conclusions, and poll topics support a limited subset of inline markdown: **bold**, _italic_, ~~strikethrough~~, `code`, [links](), bare-URL autolinks, and a small set of inline HTML tags (`<a>`, `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<s>`, `<del>`, `<ins>`, `<sub>`, `<sup>`, `<code>`, `<dfn>`, `<abbr>`, `<br>`). The canonical allowlist (and the URL scheme allowlist for links — `http:`, `https:`, `mailto:`) lives in `packages/shared/src/markdown.ts`.

Disallowed HTML, markdown images, and links with disallowed URL schemes (e.g. `javascript:` or `data:`) are **escaped to their literal source** at the write boundary — the user's text appears as written, with angle brackets and parentheses visible, rather than the save failing or the tag silently vanishing. So `<script>alert(1)</script>` typed into an agenda item name is stored and rendered as the visible text `<script>alert(1)</script>` (no script executes; no element is created). The strict validator still rejects markdown-level constructs that have no HTML equivalent in this context: submitting a heading, list, table, blockquote, code block, or multiple paragraphs in an inline-only field surfaces a specific error like _"Headings are not supported"_. Rendering is **lenient**: legacy stored content that pre-dates the validator is escaped or flattened to its supported subset rather than crashing the page. Agenda import is also lenient — disallowed nodes inside an imported item name are escaped to visible text, not cause to reject the import.

GitHub issue and PR links get a display-time prettification: when the source is a bare URL autolink or a `[url](url)`-style link with no custom text, a URL of the form `https://github.com/<org>/<repo>/(issues|pull)/<number>` renders as `org/repo#number` (e.g. `tc39/ecma262#3776`). Links with author-supplied text (e.g. `[the PR](url)`) are rendered as written. Sub-views such as `/files` or `/commits/...` are not shortened. The link target is unchanged — only the displayed text differs.

### Agenda Display

The Agenda tab shows the list of meeting chairs at the top, followed by a numbered list of agenda items. Each item shows its name (with inline markdown rendered), a badge per presenter (each with GitHub avatar, display name, and organisation), and the duration if set — labelled as an "Estimate" for current and future items and as a "Duration" for past items (since the value has been overwritten with the actual elapsed time). Items where the current user is one of the presenters are visually distinguished with a coloured left border.

The current agenda item — the one actively being discussed — is displayed with a background highlight and a high-contrast text colour so it stands out from the rest of the list. Items that have already been covered (those sitting above the current item) are dimmed/greyed. All other items use the default styling. Before the meeting starts, no item is highlighted or dimmed. Dimmed past items remain fully interactable: chairs can still edit them, delete them, or drag them to reorder. Past items that have a saved conclusion render the conclusion text underneath the item name (with inline markdown rendered).

Whenever the Agenda tab becomes visible — switching to it from another tab, or landing on it via the URL fragment — the current agenda item is automatically scrolled into the centre of the viewport, so a participant returning to the agenda doesn't have to hunt for the actively-discussed row. The scroll is a no-op when there is no current item (e.g. before the meeting starts or after it has concluded).

### Sessions

A **session** is a named time block that visually groups a contiguous run of agenda items by capacity. Sessions are not themselves agenda items — advancement (next agenda item) skips over them, and the items a session "contains" are derived from its position in the list, not from any parent/child linkage.

- **Add** — Alongside the "New Agenda Item" button, chairs see a "New Session" button. Creating a session takes a **name** and a **capacity** (positive integer number of minutes). New sessions are appended to the end of the agenda; chairs reorder them into position afterwards.
- **Edit** — Chairs can edit a session's name and capacity inline.
- **Delete** — Removing a session does **not** delete the agenda items that were visually contained within it; only the session header is removed.
- **Reorder** — Sessions can be dragged up and down to rearrange them. Unlike agenda items, a session has no drag handle — its entire header row is the drag target. Moving a session does not move the agenda items that were contained within it; containment is recomputed from the session's new position.
- **Display** — A session renders as a distinct header row in the agenda list (bold, uppercase, with dividers). It shows three values formatted in a compact duration format (e.g. `45m`, `2h`, `5h15m`):
  - **capacity** — the session's duration
  - **used** — the sum of durations of the agenda items that fit within its capacity (items without a duration count as 0m)
  - **remaining** — capacity − used, when the full run fits, OR
  - **overflow** — (run total − capacity) when the contiguous run of items that follows the session exceeds its capacity. The "overflow" label replaces the "remaining" label in that case, rendered in a warning colour.
- **Containment** — The run of agenda items under a session starts at the item immediately after the session and ends at the next session header (or end of agenda). Items whose cumulative durations stay within the capacity are rendered with a left/right margin so they sit visually "inside" the session. Items that would push the running sum past capacity are still indented (they belong to the session's run) but are grouped under an auto-inserted **overflow** subheader, described below.
- **Overflow subheader** — When a session's run exceeds its capacity, an indented "overflow" subheader is inserted automatically before the first overflowing item, dividing the run into a contained prefix and an overflow tail. The subheader is rendered in a warning colour and is not draggable; it disappears as soon as the run fits again (e.g. after a reorder or duration edit). All items in the overflow tail stay indented alongside their contained siblings — the subheader, not de-indentation, is what signals that they exceed capacity.
- **Per-item overflow text** — The first item in each session's overflow tail carries a red `(overflows Xm)` annotation next to its duration, stating in plain text how much of the item sits past the preceding session's capacity. Later items in the same overflow tail do not repeat the badge — the overflow subheader plus this single annotation already mark the boundary.
- **Live elapsed time** — The current agenda row displays a `(elapsed M:SS)` (or `(elapsed H:MM:SS)` past an hour) readout next to its estimate, updating once per second. The readout disappears as soon as the chair advances past the item.

### Agenda Prologue and Epilogue

Chairs can attach two optional, free-form, sanitised-markdown sections to the agenda:

- **Prologue** — rendered above the agenda list (between the chairs section and the first agenda item).
- **Epilogue** — rendered below the agenda list.

Both fields accept a wider subset of markdown than the inline allowlist: paragraphs, headings (h1–h6), ordered and unordered lists (including nesting), thematic breaks (`---`), blockquotes, fenced code blocks, GFM tables, `<details>`/`<summary>` disclosure blocks, plus everything from the inline subset (bold, italic, code, links, autolinks, line breaks, allowed inline HTML). Every supported markdown construct's corresponding raw-HTML tag is also accepted, so authors can write `# heading` or `<h1>heading</h1>` interchangeably. Anything outside the allowlist — images, generic structural tags (`<div>`, `<span>`), XSS-vector tags/attributes (`<script>`, `<iframe>`, `<form>`, `on*` handlers, `style`, `class`, `id`, …), and `javascript:` / `data:` link schemes — is escaped to its literal source so the original markup appears as written; no element is created and nothing executes.

#### Visibility

- **Non-chair participants** see only sections that have been populated. When a section is unset, nothing is rendered in its slot.
- **Chairs** always see a full-width, dashed-border placeholder labelled "Add an agenda prologue" / "Add an agenda epilogue" when the section is unset, so the affordance is discoverable.

#### Editing (Chair Only)

Clicking the dashed placeholder (or the chair-only "edit" control on a populated section) replaces the section with an auto-focused multi-line textarea pre-populated with the current value, and Save / Cancel buttons. Pressing Ctrl/Cmd+Enter while the textarea is focused is equivalent to clicking Save.

Two destructive / overwriting actions are gated behind a confirmation dialogue:

- **Deleting a populated section** — clicking the chair-only "delete" control opens a "Delete prologue/epilogue?" dialogue. The section is only cleared once the chair confirms.
- **Knowingly overwriting another chair's changes** — when the conflict banner (described below) is showing, clicking Save opens an "Overwrite prologue/epilogue?" dialogue before the chair's draft is committed. Without the conflict banner, Save submits directly.

Saving with an empty textarea still clears the section directly (no confirmation), since the chair is acting on their own draft rather than on another chair's saved content. The two flows differ in scope: the "delete" control acts on the saved content; emptying the editor acts on the chair's own working draft.

#### Concurrent Edits

If another chair updates the same section while the editor is open, a sticky warning banner appears above the textarea ("Another chair has updated the [prologue/epilogue] while you were editing. Saving will overwrite their changes."). The banner does **not** auto-dismiss — chairs can finish their thought and read the warning afterwards. It clears when the chair dismisses it explicitly (×), cancels the edit, or saves. Clicking Save while the banner is showing opens the overwrite confirmation dialogue described above.

#### Rendering

Once populated, the section is rendered for every participant using the block-markdown renderer described above. Links open in a new tab with `rel="noopener noreferrer"` set, matching how inline-markdown links behave elsewhere in the UI. Chairs see "edit" and "delete" affordances in the top-right of each populated section, mirroring the controls on agenda items and queue entries.

## Queue

The queue is the core of the application. It determines who speaks next.

### Queue Entry Types

There are four types of queue entry, listed here from highest to lowest priority:

1. **Point of Order** — procedural matters (displayed in red, with a highlighted background across the full row)
2. **Clarifying Question** — questions for clarification (displayed in green)
3. **Reply** — a response to the current topic being discussed (displayed in blue); only available when there is a current topic
4. **New Topic** — a new line of discussion (displayed in a distinct colour)

When a participant enters the queue, their entry is automatically inserted at the correct position based on type priority. Within the same type, entries are ordered FIFO (first in, first out). Duplicate entries by the same user are allowed.

### Queue Open / Close

The queue can be open or closed. When the queue is closed, non-chair participants cannot add new New Topic, Reply, or Clarifying Question entries — those entry type buttons are disabled and a "The queue is closed. You can still raise a Point of Order." message is shown. Point of Order entries remain available to all participants even when the queue is closed, because they are procedural interruptions that must never be suppressed. Chairs can still add any entry type when the queue is closed (e.g. via Restore Queue or on behalf of others).

The queue is closed by default when a meeting is created (before the meeting starts). When a chair advances to a new agenda item, the queue is automatically reopened, even if a chair had manually closed it during the previous item. Chairs can manually close and reopen the queue at any time via the **Close Queue** / **Open Queue** button in the Speaker Queue section header. Keyboard shortcuts for adding queue entries are also blocked for non-chairs when the queue is closed, with the exception of `p` (Point of Order), which remains active.

### Entering the Queue

Clicking one of the entry type buttons immediately adds the participant to the queue in a "composing" state. The entry appears in the queue for all connected users in real time: for the author, an inline editor opens pre-filled with the default topic for that entry type (for example, "New topic" or "Clarifying question"), with the text selected so they can type to replace it or submit it as-is; for everyone else, the entry's topic area displays a bouncing-dots typing indicator signalling that the author is still composing. The Reply button is only visible when there is a current topic, and the `r` keyboard shortcut is similarly a no-op when there is no current topic.

Because the button and the server-side add happen over the network, the current topic may change in the gap between a participant clicking Reply and the server processing the add. The reply is rejected in either of two cases. If a chair has advanced to a different topic (one that is still current), the participant sees "Topic has changed — your reply was not added". If there is no current topic at all when the server processes the reply (for example, the agenda item has just been advanced and the topic has been cleared), the participant sees "No topic is currently active - you can not reply". In both cases the inline edit form does not open and no typing-indicator entry is created.

If the participant clicks Save with a non-empty input, that text becomes the entry's topic and the typing indicator is replaced with the topic text on every viewer's screen. If they leave the composing state via Escape, Cancel, or Save with an empty input, the entry is removed from the queue. Cancelling an edit on an already-saved entry (opened via the Edit button) is a separate flow that leaves the entry unchanged. While an entry is in the composing state, chairs cannot edit it (the pencil affordance is suppressed); chairs retain the ability to delete it.

If the author's connection drops before they save (e.g. they close the tab), the server removes the entry on their behalf, so the typing indicator does not linger on remaining participants' screens.

The bouncing-dots animation respects the viewer's reduced-motion preference: when reduced motion is requested, the dots are shown as static, faintly visible markers instead of animating.

### Saved Topics

Beside the entry-type buttons sits a "Saved topics" button — a recycle emoji (♻️) with a downward-pointing triangle indicating it opens a dropdown. The dropdown lists the user's saved queue topics (each prefixed with the emoji of its configured priority and truncated with ellipsis to fit, with the full text on hover) followed by an **Edit saved topics…** entry. Clicking a saved topic immediately adds an entry to the queue with the chosen text as its topic, at the saved topic's **configured priority** (one of New Topic, Reply, Clarifying Question, or Point of Order), skipping the composing state entirely — the entry appears as a finished entry on every viewer's screen the moment the server processes it, with no typing indicator and no inline editor on the author's side.

Each saved topic only makes sense when its priority is currently addable, so the dropdown disables any entry whose priority is not valid right now: a **Reply** entry is disabled when no topic is active, and every entry except **Point of Order** is disabled for non-chairs while the queue is closed (Point of Order, a procedural interruption, is always permitted). A disabled entry shows the reason on hover and cannot be selected. The **Saved topics** button itself is always openable — in any meeting state — so that Point of Order entries and the **Edit saved topics…** link stay reachable. In the rare case a saved topic's priority becomes invalid between opening the dropdown and clicking it (for example, the chair advances past the active topic), the selection is rejected: an error is shown and nothing is added to the queue.

Each user has their own list of saved topics, persisted to the browser's local storage keyed by GitHub user ID, so two accounts sharing a browser do not see each other's list. A user with no stored list (the first time they open the dropdown) is automatically seeded with a single default entry: "👍 I support this. (EOM)". A user who has explicitly emptied their list is not re-seeded; the dropdown shows only the **Edit saved topics…** entry.

The editing interface is a section of the Preferences modal titled **Saved topics**. It lists each saved entry as a row containing a drag handle, an inline text input, a priority selector, and a delete button (✕). The priority selector is a compact dropdown showing the chosen priority's emoji (the human-readable label is available as its accessible name and on hover); changing it sets which queue-entry type that saved topic posts as. New saved topics default to **New Topic** priority. Edits to the text commit on blur or Enter; pressing Escape inside an input reverts that row without closing the modal. Entries can be reordered by dragging. The **Add saved topic** button below the list inserts a new empty row and focuses its input; if the user blurs the input without typing anything, the empty row is removed. There is a hard cap of five saved topics per user — the **Add** button is disabled once the cap is reached. Empty edits do not persist; a row whose text is cleared and then blurred reverts to its previous value.

### Queue Display

Each queue entry shows:

- Position number (centre-aligned)
- Type badge (e.g. "New Topic", "Reply", "Clarifying Question", "Point of Order")
- Topic description
- Speaker name, organisation, and GitHub avatar

The user's own queue entries are visually distinguished with a coloured left border. Chairs see a drag handle (⠿) to the left of each entry for reordering. Participants see a drag handle on their own entries. Edit and delete buttons appear on the right side: chairs see them on all entries, participants see them on their own entries only.

### Queue Advancement

- **Next Speaker** (chair action) — the first person in the queue becomes the current speaker; their entry is removed from the queue.
- If the queue is empty when advancement occurs, the current speaker is cleared.
- If a chair's view of the current speaker or current agenda item is out of date when the **Next Speaker** or **Next Agenda Item** action reaches the server (for example, another chair has just advanced), the action is rejected to prevent conflicts.
- Both the **Next Speaker** and **Next Agenda Item** actions are debounced to ignore rapid repeated activations. After a change triggered by another user is received from the server, the action enters a brief cooldown during which it is disabled (visually greyed out and non-interactive), preventing accidental double-advancement.
- The **Next Speaker** action additionally enters the same cooldown when the entry that was next-up is deleted out of the queue (for example, its owner removes it just as the chair is about to advance). This prevents the chair from accidentally advancing past the intended speaker to whoever shifts into first place. Reordering the queue or inserting a new entry ahead of the next-up one does not trigger the cooldown — only deletion of the next-up entry does.

### Queue Reordering

Chairs can drag-and-drop any queue entry to reorder it. Participants can drag their own entries downward freely (deferring their position) and upward only across other entries they themselves own — that is, they may reorder among their own contiguous block but never jump ahead of someone else's entry.

The hover cursor on each drag handle reflects the legal directions for that specific entry: a north-south double arrow when both up and down are available, a south arrow when only deferring is possible, and a north arrow when only upward movement within the participant's own block is possible. The handle is omitted entirely when no move is possible (for example, a chair viewing a single-entry queue, or a participant whose only entry sits at the bottom under someone else's).

When an entry is moved, its type changes based on direction:

- **Moving down:** the entry adopts the lowest priority of the items at or above it (including itself).
- **Moving up:** the entry adopts the highest priority of the items at or below it (including itself).

This ensures the entry's type remains consistent with the priority ordering of its neighbours.

### Queue Type Cycling

Chairs can click the type badge (e.g. "New Topic:") on any queue entry to cycle through the types that are legal at that position. A type is legal if changing to it would not break the priority ordering — it must be at least as low-priority as the lowest-priority item above and at least as high-priority as the highest-priority item below. When only one type is legal, the badge is not clickable. Participants cannot change entry types.

### Queue Editing

Chairs can edit any queue entry's topic inline. Participants can edit their own entries. The drag handle remains active while an entry is in edit mode (subject to the same per-entry move rules described under "Queue Reordering"), so a reorder mid-edit preserves the in-progress changes.

### Copy and Restore Queue (Chair Only)

Chairs can copy the entire queue to the clipboard in a human-readable text format, one entry per line:

```
New Topic: My discussion point (alice)
Clarifying Question: How does this work? (bob)
```

Chairs can also restore a queue by pasting entries in this format. When a line includes a trailing `(username)`, the entry is added on behalf of that user, preserving the original author. The username is resolved against known meeting participants (chairs, existing queue entries, agenda presenters); unknown usernames create a placeholder user. Non-chairs cannot add entries on behalf of other users.

### Current Speaker

The currently speaking person is displayed prominently, showing their GitHub avatar, name, organisation, and the topic/question they queued with. A count-up timer shows how long the current speaker has been speaking (updated every second). Only one person speaks at a time.

### Current Topic

When a speaker introduces a new topic, that topic becomes the "current topic" and is displayed in a dedicated section. A count-up timer shows how long the current topic has been under discussion. The current topic determines whether the "Reply" queue entry type is available, and the reply form references the current topic by name.

### Timers

The Queue tab displays live count-up timers on three elements:

- **Current agenda item** — time since the agenda item started. If the item has an estimate, the timer turns bold red when the estimate is exceeded, and is annotated with the projected end time:
  - Before the estimate is reached, the annotation reads "expected to end by HH:MM" using the viewer's local time and locale (12- or 24-hour format follows the locale). When the projected end time falls on the next local day, "tomorrow" is appended; for two or more days out, an explicit weekday and date are appended (e.g. "expected to end by 09:00 on Wed, 4 May").
  - Once the estimate is exceeded, the annotation switches to "exceeded estimate <relative time> ago" (e.g. "4 min ago", "1d ago"), and hovering it shows the full timestamp at which the estimate was exceeded.
- **Current topic** — time since the current topic was introduced.
- **Current speaker** — time since the current speaker began speaking.

Timers update every second and are displayed in M:SS format (or H:MM:SS for durations over an hour). They remain visible in presentation mode. Point of Order speakers, being procedural interruptions, do not display a speaker timer.

## Polls

A poll is a lightweight, real-time sentiment check that allows the chair to gauge participant opinion on the current topic.

### Configuration (Chair Only)

When a chair clicks **Poll**, a setup form appears with an optional topic/question field at the top, followed by a list of response options. Each option has an emoji and a label. The six default options are:

| Emoji | Label           |
| ----- | --------------- |
| ❤️    | Strong Positive |
| 👍    | Positive        |
| 👀    | Following       |
| ❓    | Confused        |
| 🤷    | Indifferent     |
| 😕    | Unconvinced     |

Chairs can add, remove, and edit options before starting the poll. Each option's emoji is selected via a dedicated emoji picker with search and categories. A minimum of 2 options is required. A checkbox controls whether participants can select multiple options (default) or only one. The chair clicks **Start Poll** to begin.

### Reactions

During an active poll, all participants see a modal with the poll topic (if provided), a count-up timer showing how long the poll has been open, and a panel of buttons — one for each option — showing the emoji, label, and reaction count. Clicking a button toggles the user's reaction (adds if not present, removes if already selected). In single-select mode, selecting a new option automatically deselects the previous one. Each button shows how many participants have selected it. Hovering over a button shows the names of the participants who reacted. The user's own selected reactions are visually highlighted. This modal is **non-dismissable** — participants cannot close it with Esc or by clicking outside; it disappears for everyone only when the chair stops the poll.

### Results

Chairs see a **Copy Results** button that copies a summary to the clipboard: each option's emoji, label, and count on a separate line, sorted by count descending.

### Termination (Chair Only)

**Stop Poll** ends the poll, clears all reactions and options.

## Log

The Log tab provides a chronological record of meeting events, giving participants a timeline of what has happened during the meeting. The log is maintained as part of the persisted meeting state and updated for all clients in real time.

### Log Entries

Each log entry records:

- **Event type** — determines the description format.
- **Timestamp** — ISO 8601, set by the server when the event occurs.
- **Event-specific data** — varies by event type (see below).

### Event Types

The following events are logged:

| Event                    | Logged when                                                                                                            | Description format                                              | Additional data                                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Meeting started**      | Chair advances to the first agenda item                                                                                | "Meeting started"                                               | —                                                                                                                                                                                                                                                        |
| **Agenda item started**  | Chair advances to a new agenda item                                                                                    | "Started: _item name_"                                          | Item presenters (the first presenter is the initial speaker; may be empty for items with no presenters, in which case no initial speaker is set)                                                                                                         |
| **Agenda item finished** | Chair advances past an agenda item (i.e. the next item starts, completing the previous one)                            | "Finished: _item name_"                                         | Duration, participant summary (all distinct users who spoke during the item, excluding any Point of Order speakers), remaining queue (text serialisation of any entries left in the queue when the item was advanced, shown in a collapsible disclosure) |
| **Topic discussed**      | Chair advances the speaker, and the new speaker's entry type is "New Topic" or the first presenter's introductory turn | Topic name with speaker's user badge inline                     | Total topic duration, list of reply/clarification speakers with their durations (see Speaker Grouping below)                                                                                                                                             |
| **Poll ran**             | Chair stops a poll                                                                                                     | "Ran a poll" (or "Ran a poll: _topic_" if a topic was provided) | Chair who ran it (or both chairs if different people started and stopped), poll topic (if provided), duration, total number of voters, results summary (each option's emoji, label, and count)                                                           |

### Speaker Grouping

Speaker changes are not logged as individual top-level events. Instead, they are grouped under the topic they relate to. Each **Topic discussed** log entry has two display formats:

**Compact format** (single speaker, no replies or clarifications): the topic name, total duration, and speaker's user badge are shown on a single line. The speaker's entry is not repeated as a nested row.

**Expanded format** (multiple speakers): the topic name, total duration, and the first speaker's user badge are shown on the heading line. Replies and clarifying questions appear as nested rows below, each showing their entry type badge, topic/question text, individual duration, and user badge. The first speaker is not duplicated as a nested row since it already appears in the heading.

Point of Order entries are excluded from the log entirely — they are procedural interruptions and not part of the discussion record.

The current (ongoing) topic group remains open — its last speaker has no duration yet and is labelled "ongoing".

### Durations

The "Agenda item finished" entry's duration covers the full time from when the item started to when it was advanced. Each topic discussed entry shows the total time for that topic group. Within an expanded topic group, each individual speaker has their own duration.

### Display

The Log tab shows log entries in reverse chronological order (most recent first). Each entry displays a relative time (e.g. "5 minutes ago") that updates live, with the full timestamp shown on hover in the viewer's locale and time zone. Entries are visually grouped by agenda item. Item names and topics render inline markdown.

### Export

The **Export** button downloads a Markdown file (named `{meeting-id}-{epoch-seconds}.md`) containing the full meeting log in chronological order (oldest events first). Agenda items are rendered as headings, speaker topics as nested lists with entry types in bold, and poll results as lists. All timestamps are UTC. The file ends with a **Participants** summary table listing every user who has joined the meeting via a socket connection, sorted by total speaking time (descending); attendees who joined but never spoke are included with a duration of `0s`. The button is hidden when the log is empty and in presentation mode.

### Persistence

The log is permanent and cannot be edited or deleted during the meeting's lifetime. It is available to all connected participants and updated in real time.

## User Identity Display

Wherever a user's name is shown (agenda item presenters, queue entry speakers, current speaker, chairs list, poll tooltips, navigation bar), their GitHub avatar is displayed alongside their name and organisation. Avatars are loaded from GitHub and hidden gracefully if the image fails to load. Hovering a badge reveals the user's GitHub login as a tooltip, so the underlying username is recoverable when display name and login differ.

## Keyboard Shortcuts

Pressing `?` opens a dialog listing all keyboard shortcuts. The dialog includes a toggle button to enable or disable shortcuts; this preference is persisted to `localStorage` and defaults to enabled. Shortcuts are always disabled when the user is typing in a text field. The `Escape` key works even when shortcuts are globally disabled, so that any open dialog can always be dismissed. Available shortcuts:

| Key | Action                      |
| --- | --------------------------- |
| `n` | New Topic                   |
| `r` | Reply to current topic      |
| `c` | Clarifying Question         |
| `p` | Point of Order              |
| `s` | Next Speaker (chair only)   |
| `f` | Toggle presentation mode    |
| `1` | Switch to Agenda tab        |
| `2` | Switch to Queue tab         |
| `3` | Switch to Log tab           |
| `4` | Switch to Help tab          |
| `?` | Toggle shortcuts dialogue   |
| `,` | Toggle preferences dialogue |

## Preferences

The hamburger menu in the top-right navigation contains a **Preferences** entry that opens a modal for user-facing settings. The modal can also be toggled with the `,` keyboard shortcut. It is a modal dialog: while it is open, keyboard focus is trapped inside it, and it can be dismissed by pressing `Escape`, clicking outside it, using the platform back gesture, or clicking its close (✕) button. On dismissal, focus returns to whatever was focused before it opened. Changes are saved immediately to `localStorage` and applied right away — there is no explicit Save button. Current preferences:

- **Keyboard shortcuts** — enable or disable global keyboard shortcuts. Mirrors the toggle inside the `?` dialog; both locations read and write the same value.
- **Notifications** — a top-level toggle plus four per-event toggles (see the Notifications section below).
- **Colour scheme** — choose Light, Dark, or System. System (the default) follows the operating system's `prefers-color-scheme`; Light and Dark override it.

## Notifications

Browser-native notifications can be enabled from the Preferences modal. The top-level **Notifications** toggle is off by default; the first time the user switches it on, the browser prompts for permission. If permission is granted, the toggle stays on. Per-event sub-toggles default to on, except for the two chair-oriented ones (point of order and agenda-item overrun) which default to off:

- **When your queue entry is next** — a queue entry you authored has reached the head of the queue.
- **When your agenda item is next** — the agenda item immediately after the current one lists you as one of its presenters. Each presenter who has opted in is notified independently. (Items with no presenters trigger no notifications.)
- **When the meeting has started** — fires once when the first agenda item becomes active. Mutually exclusive with "agenda advances" — only the meeting-started notification fires on the initial transition.
- **When the agenda advances** — the current agenda item has changed after the meeting is already underway.
- **When a poll has started** — a chair has opened a new poll. The chair who started the poll is not notified about their own action.
- **When a clarifying question is raised on your topic** — you are the current topic author, and someone else has queued a clarifying question. You are not notified about your own questions.
- **When a point of order is raised** — another participant has added a point-of-order entry. The author of a point of order is not notified about their own. Off by default.
- **When the current agenda item exceeds its time estimate** — a time-based notification that fires once, the moment the current agenda item crosses its estimate. Skipped if the item was already overrun when the page loaded. Off by default.

If the user denies permission at the browser prompt (or permission was already denied for the site), the top-level toggle silently stays off. If permission is later revoked through browser settings, the next in-page transition detects the change, self-heals the preference back to off, and no notification is fired. Notifications fire regardless of whether the tab is in the foreground.

Notification bodies that draw on user-authored markdown fields (topics, agenda item names, conclusions) are shown as plain text — link syntax collapses to the link label and any other inline markdown is stripped — because the browser's Notifications API displays the body verbatim with no formatting support.

All settings persist to `localStorage`.

## Presentation Mode

Pressing `f` toggles presentation mode. In presentation mode:

- The browser enters fullscreen.
- The navigation bar is hidden.
- All interactive controls are hidden: forms, entry type buttons, drag handles, edit/delete buttons, and chair action buttons.
- The queue content, current speaker, current topic, agenda items, and poll reactions remain visible.

Pressing `f` again (or exiting fullscreen via the browser) returns to normal mode.

## Dark Mode

The application supports light and dark palettes, controlled by the **Colour scheme** setting in the Preferences modal. The default is `System`, which follows the operating system's `prefers-color-scheme` and switches live when the OS setting changes. Users can override by selecting `Light` or `Dark`, and the choice is persisted to `localStorage`.

## Accessibility

UI elements should meet the WCAG 2 AA minimum contrast ratio thresholds (4.5:1 for normal text, 3:1 for large text) in both the light and dark palettes so that users with low vision can read the interface without strain.

Any animations should be disabled when the user agent indicates that the user prefers reduced motion (i.e. the CSS `prefers-reduced-motion: reduce` media query matches).

## Real-Time Updates

All meeting state changes are broadcast to all connected participants in real time. This includes:

- Agenda item additions, edits, deletions, and reordering
- Queue additions, edits, deletions, and reordering
- Current speaker and current topic changes
- Agenda item advancement
- Poll state, options, and reactions
- Log entries for significant meeting events

A small connection status indicator is displayed in the bottom-right corner of the meeting page: green when connected to the server, red when disconnected. This helps participants know whether they are seeing live state. While connected, hovering the indicator reveals the current number of active connections to the meeting.

If the deployed server version changes while a participant is in a meeting — for example after a redeploy — a banner appears at the top of the meeting page reading "A new version of TCQ is available. Reloading in N seconds&hellip;" with a countdown and an immediate "Reload now" button. The page reloads automatically after the countdown. The short grace period lets participants copy anything they were typing before the reload discards in-progress input. The check is scoped to the meeting page (the only surface that pins the participant to a specific server via a long-lived WebSocket); other pages reload naturally on next interaction.

## Error Handling

- Fatal errors (e.g. "Meeting not found") are shown as a full-page error with a link back to the home page.
- Non-fatal errors (e.g. "Only chairs can...") are shown as a dismissible red banner at the top of the meeting page.

## Persistence

Meeting state is persisted and survives server restarts. Meetings are automatically deleted 90 days after the last time any client was connected to them.
