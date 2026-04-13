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
- React during a temperature check

### Chairs

Chairs are designated when a meeting is created. In addition to all participant capabilities, chairs can:

- Create meetings
- Add, edit, delete, and reorder agenda items
- Start the meeting / advance to the next agenda item
- Advance to the next speaker
- Edit, reorder, and remove any entry in the speaker queue
- Initiate, configure, and stop temperature checks
- Copy temperature check results to the clipboard

## Authentication

Users authenticate via GitHub OAuth. Their GitHub display name, username, and organisation are used as their identity within the application.

When GitHub OAuth is not configured (no `GITHUB_CLIENT_ID` environment variable), the server runs in mock auth mode with a fake user, allowing development without creating an OAuth App. In mock auth mode, a dev user-switcher in the navigation bar allows switching between different mock identities.

## Meetings

### Creating a Meeting

An authenticated user creates a meeting by specifying one or more chairs as a comma-separated list of GitHub usernames. When OAuth is configured, chair usernames are validated against the GitHub API. The system generates a meeting ID consisting of a short sequence of memorable, easily distinguished words.

### Joining a Meeting

Any authenticated user can join a meeting by entering its meeting ID or by navigating to the meeting's permalink (which includes the meeting ID in the URL). Upon joining, the user receives the full current meeting state and all subsequent real-time updates.

If a user navigates to a non-existent meeting, a clear error page is shown with a link back to the home page.

## Home Page

The home page shows two cards side by side:

- **Join Meeting** — a text input for the meeting ID and a "Join" button. Validates that the meeting exists before navigating to it.
- **New Meeting** — a text input for chair GitHub usernames (comma-separated), pre-populated with the current user's username. A "Start a New Meeting" button creates the meeting and redirects to it.

## Agenda

The agenda is an ordered list of items. Each agenda item has:

- **Name** — the title of the item
- **Owner** — a GitHub user who will introduce/present it (shown with their GitHub avatar)
- **Timebox** (optional) — a duration in minutes

### Agenda Management (Chair Only)

- **Add** — Create a new agenda item by specifying a name, owner (GitHub username, validated against GitHub when OAuth is configured), and optional timebox. The form fields are: Agenda Item Name (flexible width), Owner (pre-populated with current user), and Timebox in minutes.
- **Edit** — Inline edit of an existing agenda item's name, owner, and timebox.
- **Delete** — Remove an agenda item.
- **Reorder** — Drag-and-drop to rearrange agenda items. The entire agenda item row is the drag target.

### Agenda Display

The Agenda tab shows the list of meeting chairs at the top, followed by a numbered list of agenda items. Each item shows its name, owner (with GitHub avatar, display name, and organisation), and timebox duration if set.
## Queue

The queue is the core of the application. It determines who speaks next.

### Queue Entry Types

There are four types of queue entry, listed here from highest to lowest priority:

1. **Point of Order** — procedural matters (displayed in red)
2. **Clarifying Question** — questions for clarification (displayed in green)
3. **Reply** — a response to the current topic being discussed (displayed in blue); only available when there is a current topic
4. **New Topic** — a new line of discussion (displayed in a distinct colour)

When a participant enters the queue, their entry is automatically inserted at the correct position based on type priority. Within the same type, entries are ordered FIFO (first in, first out). Duplicate entries by the same user are allowed.

### Entering the Queue

Clicking one of the entry type buttons immediately adds the participant to the queue with a placeholder topic description. The entry appears in the queue for all connected users in real time, and the new entry's topic field opens in inline edit mode with the placeholder text selected so the participant can immediately type a more specific description. The Reply button is only visible when there is a current topic.

### Queue Display

Each queue entry shows:

- Position number (centre-aligned)
- Type badge (e.g. "New Topic", "Reply", "Clarifying Question", "Point of Order")
- Topic description
- Speaker name, organisation, and GitHub avatar

Chairs see a drag handle (⠿) to the left of each entry for reordering. Edit and delete buttons appear on the right side: chairs see them on all entries, participants see them on their own entries only.
### Queue Advancement

- **Next Speaker** (chair action) — the first person in the queue becomes the current speaker; their entry is removed from the queue. Uses a version counter to prevent double-advancement from concurrent chair clicks, with automatic client-side retry on stale version.
- If the queue is empty when advancement occurs, the current speaker is cleared.

### Queue Reordering (Chair Only)

Chairs can drag-and-drop queue entries to reorder them. When an entry is moved across a type boundary (e.g. a "New Topic" is moved above a "Clarifying Question"), the entry's type changes to match its neighbour at the new position. Reordering uses UUID-based positioning (not indices) to avoid race conditions.

### Queue Editing

Chairs can edit any queue entry's topic inline. Participants can edit their own entries. The entry type badge is shown but not editable inline.

## Current Speaker and Current Topic

### Current Speaker

The currently speaking person is displayed prominently, showing their GitHub avatar, name, organisation, and the topic/question they queued with. Only one person speaks at a time.

### Current Topic

When a speaker introduces a new topic, that topic becomes the "current topic" and is displayed in a dedicated section. The current topic determines whether the "Reply" queue entry type is available, and the reply form references the current topic by name.

## Meeting Flow

1. A chair creates a meeting and shares the meeting ID with participants.
2. Participants join.
3. The chair clicks **Start Meeting** to advance to the first agenda item. The agenda item's owner automatically becomes the current speaker.
4. Participants enter the queue to discuss the item.
5. The chair advances through the queue.
6. When discussion on an agenda item is complete, the chair clicks **Next Agenda Item** to advance, and the next item's owner becomes the current speaker. The queue and current topic are cleared.
7. This repeats until the agenda is exhausted.

Before the meeting is started, the queue view displays "Waiting for the meeting to start..." with a **Start Meeting** button (visible to chairs). The **Next Agenda Item** button is hidden when on the last agenda item.

## Temperature Checks

A temperature check is a lightweight, real-time poll that allows the chair to gauge participant sentiment on the current topic.

### Configuration (Chair Only)

When a chair clicks **Check Temperature**, a setup form appears with a list of response options. Each option has an emoji and a label. The six default options are:

| Emoji | Label |
|-------|-------|
| ❤️ | Strong Positive |
| 👍 | Positive |
| 👀 | Following |
| ❓ | Confused |
| 🤷 | Indifferent |
| 😕 | Unconvinced |

Chairs can add, remove, and edit options before starting the check. Each option's emoji is entered via a text input (the OS emoji picker can be used). A minimum of 2 options is required. The chair clicks **Start Temperature Check** to begin.

### Reactions

During an active temperature check, all participants see a panel of buttons — one for each option — showing the emoji, label, and reaction count. Clicking a button toggles the user's reaction (adds if not present, removes if already selected). Each button shows how many participants have selected it. Hovering over a button shows the names of the participants who reacted. The user's own selected reactions are visually highlighted.

### Results

Chairs see a **Copy Results** button that copies a summary to the clipboard: each option's emoji, label, and count on a separate line, sorted by count descending.

### Termination (Chair Only)

**Stop Temperature Check** ends the temperature check, clears all reactions and options.

## Real-Time Updates

All meeting state changes are broadcast to all connected participants in real time. This includes:

- Agenda item additions, edits, deletions, and reordering
- Queue additions, edits, deletions, and reordering
- Current speaker and current topic changes
- Agenda item advancement
- Temperature check state, options, and reactions

The server is the single source of truth. Clients send actions and wait for the server to broadcast the updated state — no optimistic updates.

## Error Handling

- Server-side validation errors are sent to clients via a Socket.IO `error` event.
- Fatal errors (e.g. "Meeting not found") are shown as a full-page error with a link back to the home page.
- Non-fatal errors (e.g. "Only chairs can...") are shown as a dismissible red banner at the top of the meeting page.

## User Identity Display

Wherever a user's name is shown (agenda item owners, queue entry speakers, current speaker, chairs list, temperature check tooltips, navigation bar), their GitHub avatar is displayed alongside their name and organisation. Avatars are loaded from `https://github.com/{username}.png` and hidden gracefully if the image fails to load.

## Navigation

The meeting view has two tabs:

- **Agenda** — displays the chairs list, the ordered list of agenda items with management controls for chairs, and the new agenda item form.
- **Queue** — displays the current agenda item (with temperature check controls), current topic, current speaker (with Next Speaker button), speaker entry controls, and the speaker queue.

The active tab is indicated with a teal underline. A top navigation bar shows the TCQ branding, the Agenda/Queue tab toggle, and the user menu (Log Out link in OAuth mode, or a clickable username with user-switcher form in mock auth mode).

## Persistence

Meeting state is held in memory on the server and periodically synchronised to a persistent store (every 30 seconds for changed meetings, immediately for high-value events like agenda/speaker advancement). On server startup, meetings are restored from the store. When all clients disconnect from a meeting, a cleanup timer starts (5 minutes); if no one reconnects, the meeting is deleted.

Two store implementations:

- **File store** (default, for local development) — each meeting is a JSON file on disk.
- **Firestore store** (for production) — each meeting is a document in a Firestore collection.

Sessions are stored in the same backing store (in-memory for file mode, Firestore for production).
