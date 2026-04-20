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

- View a list of all active meetings on the home page, showing each meeting's ID, chair count, agenda item count, queued speaker count, maximum concurrent connections, and time of last non-admin connection.
- Delete any meeting (with a confirmation dialogue).
- Edit the chair list for any meeting, even if they are not a chair themselves.
- Remove themselves from the chair list, including when they are the last chair (allowing an empty chair list).

Admin connections are excluded from connection statistics.

## Authentication

Users authenticate via GitHub OAuth. Their GitHub display name, username, and organisation are used as their identity within the application. Unauthenticated users see a login page with a "Log in with GitHub" button.

When GitHub OAuth is not configured, the server runs in mock auth mode with a fake user, allowing development without creating an OAuth App. In mock auth mode, a dev user-switcher in the navigation bar allows switching between different mock identities.

## Home Page

The home page shows two cards side by side:

- **Join Meeting** — a text input for the meeting ID and a "Join" button. Validates that the meeting exists before navigating to it.
- **New Meeting** — a "Start a New Meeting" button that creates a meeting with the current user as the sole chair and redirects to it. Additional chairs can be added from the Agenda tab.

## Meetings

### Creating a Meeting

An authenticated user clicks "Start a New Meeting" to create a meeting with themselves as the sole initial chair. The system generates a meeting ID consisting of a short sequence of memorable, easily distinguished words. Additional chairs can be added from the Agenda tab after the meeting is created.

### Joining a Meeting

Any authenticated user can join a meeting by entering its meeting ID or by navigating to the meeting's permalink (which includes the meeting ID in the URL). Upon joining, the user receives the full current meeting state and all subsequent real-time updates.

If a user navigates to a non-existent meeting, a clear error page is shown with a link back to the home page.

## Meeting Flow

1. A chair creates a meeting and shares the meeting ID with participants.
2. Participants join.
3. The chair clicks **Start Meeting** to advance to the first agenda item. The agenda item's owner automatically becomes the current speaker.
4. Participants enter the queue to discuss the item.
5. The chair advances through the queue.
6. When discussion on an agenda item is complete, the chair clicks **Next Agenda Item** to advance, and the next item's owner becomes the current speaker. The queue and current topic are cleared. If entries remain in the queue, a confirmation dialogue warns that they will be cleared and shows the entry count.
7. This repeats until the agenda is exhausted.

Before the meeting is started, the queue view displays "Waiting for the meeting to start..." with a **Start Meeting** button (visible to chairs). The **Next Agenda Item** button is hidden when on the last agenda item.

## Navigation

The meeting view has four tabs:

- **Agenda** — displays the chairs list, the ordered list of agenda items with management controls for chairs, and the new agenda item form.
- **Queue** — displays the current agenda item (with poll controls), current topic, current speaker (with Next Speaker button), speaker entry controls, and the speaker queue.
- **Log** — displays a reverse-chronological timeline of meeting events (agenda changes, speaker topics, polls).
- **Help** — explains how TCQ works for both chairs and participants, lists keyboard shortcuts.

The active tab is indicated with a teal underline. A top navigation bar shows the TCQ logo and branding, the tab toggles, and the user menu (user badge and a hamburger menu button in OAuth mode, or a clickable user badge with user-switcher form alongside the hamburger menu in mock auth mode). The hamburger menu opens a dropdown with Preferences and Log Out entries; clicking anywhere outside the dropdown dismisses it. The Help tab is also available on the home page.

## Agenda

The agenda is an ordered list of items. Each agenda item has:

- **Name** — the title of the item
- **Owner** — a GitHub user who will introduce/present it (shown with their GitHub avatar)
- **Timebox** (optional) — a duration in minutes

### Chair Management

The Agenda tab displays the list of chairs inline next to the "Chairs" heading. Each chair is shown as a pill-shaped badge with their avatar and name. Chairs and admins can manage the list directly:

- **Add** — a "+" icon to the right of the chair pills opens an inline username input. When OAuth is configured, new usernames are validated against the GitHub API.
- **Remove** — an "×" icon on each chair's pill removes them after a confirmation dialogue.

For regular chairs: they cannot remove themselves from the list (no remove icon is shown on their own pill), and at least one chair must remain. Admins bypass both restrictions — they can remove any chair, including themselves, even if it leaves the chair list empty.

### Agenda Management (Chair Only)

- **Add** — Create a new agenda item by specifying a name, owner (GitHub username, validated against GitHub when OAuth is configured), and optional timebox. The form fields are: Agenda Item Name (flexible width), Owner (pre-populated with current user), and Timebox in minutes.
- **Import** — When the agenda is empty, chairs can import an agenda from a TC39 agenda URL (a markdown document on the tc39/agendas GitHub repository). The server fetches the document, parses numbered list items and markdown tables to extract item names, presenters, and timeboxes. Markdown formatting in item names is preserved.
- **Edit** — Inline edit of an existing agenda item's name, owner, and timebox.
- **Delete** — Remove an agenda item.
- **Reorder** — Drag-and-drop to rearrange agenda items. The entire agenda item row is the drag target.

### Markdown in Item Names and Queue Topics

Agenda item names and queue entry topics support a limited subset of inline markdown: **bold**, _italic_, ~~strikethrough~~, `code`, and [links](). This formatting is preserved when importing agendas and rendered in the UI. Other markdown syntax is displayed as plain text.

### Agenda Display

The Agenda tab shows the list of meeting chairs at the top, followed by a numbered list of agenda items. Each item shows its name (with inline markdown rendered), owner (with GitHub avatar, display name, and organisation), and timebox duration if set. Items owned by the current user are visually distinguished with a coloured left border.

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

The queue is closed by default when a meeting is created (before the meeting starts). When a chair advances to a new agenda item, the queue is automatically reopened. Chairs can manually close and reopen the queue at any time via the **Close Queue** / **Open Queue** button in the Speaker Queue section header. Keyboard shortcuts for adding queue entries are also blocked for non-chairs when the queue is closed, with the exception of `p` (Point of Order), which remains active.

### Entering the Queue

Clicking one of the entry type buttons immediately adds the participant to the queue with a placeholder topic description. The entry appears in the queue for all connected users in real time, and the new entry's topic field opens in inline edit mode with the placeholder text selected so the participant can immediately type a more specific description. The Reply button is only visible when there is a current topic.

If the participant presses Escape or clicks Cancel at any point during the initial editing of a new entry, the entry is removed from the queue. This applies regardless of whether the placeholder text has been modified. Cancelling an edit on an existing entry (opened via the Edit button) does not remove it.

### Queue Display

Each queue entry shows:

- Position number (centre-aligned)
- Type badge (e.g. "New Topic", "Reply", "Clarifying Question", "Point of Order")
- Topic description
- Speaker name, organisation, and GitHub avatar

The user's own queue entries are visually distinguished with a coloured left border. Chairs see a drag handle (⠿) to the left of each entry for reordering. Participants see a drag handle on their own entries. Edit and delete buttons appear on the right side: chairs see them on all entries, participants see them on their own entries only.

### Queue Advancement

- **Next Speaker** (chair action) — the first person in the queue becomes the current speaker; their entry is removed from the queue.
- **I'm done speaking** (current speaker action) — when a non-chair participant is the active speaker, an "I'm done speaking" button appears next to the "Speaking" heading. Clicking it advances the queue using the same mechanism as the chair's "Next Speaker" button, allowing the speaker to voluntarily yield without waiting for a chair. The `s` keyboard shortcut is never available to non-chairs.
- If the queue is empty when advancement occurs, the current speaker is cleared.
- If two users attempt to advance the speaker simultaneously, the second action is rejected to prevent conflicts.
- The Next Speaker and "I'm done speaking" actions are debounced to ignore rapid repeated activations. After a speaker change triggered by another user is received from the server, the action enters a brief cooldown during which it is disabled (visually greyed out and non-interactive), preventing accidental double-advancement.

### Queue Reordering

Chairs can drag-and-drop any queue entry to reorder it. Participants can drag their own entries, but only downward (deferring their position — they cannot jump ahead of others).

When an entry is moved, its type changes based on direction:

- **Moving down:** the entry adopts the lowest priority of the items at or above it (including itself).
- **Moving up:** the entry adopts the highest priority of the items at or below it (including itself).

This ensures the entry's type remains consistent with the priority ordering of its neighbours.

### Queue Type Cycling

Chairs can click the type badge (e.g. "New Topic:") on any queue entry to cycle through the types that are legal at that position. A type is legal if changing to it would not break the priority ordering — it must be at least as low-priority as the lowest-priority item above and at least as high-priority as the highest-priority item below. When only one type is legal, the badge is not clickable. Participants cannot change entry types.

### Queue Editing

Chairs can edit any queue entry's topic inline. Participants can edit their own entries.

### Copy and Restore Queue (Chair Only)

Chairs can copy the entire queue to the clipboard in a human-readable text format, one entry per line:

```
New Topic: My discussion point (alice)
Clarifying Question: How does this work? (bob)
```

Chairs can also restore a queue by pasting entries in this format. When a line includes a trailing `(username)`, the entry is added on behalf of that user, preserving the original author. The username is resolved against known meeting participants (chairs, existing queue entries, agenda owners); unknown usernames create a placeholder user. Non-chairs cannot add entries on behalf of other users.

### Current Speaker

The currently speaking person is displayed prominently, showing their GitHub avatar, name, organisation, and the topic/question they queued with. A count-up timer shows how long the current speaker has been speaking (updated every second). Only one person speaks at a time.

### Current Topic

When a speaker introduces a new topic, that topic becomes the "current topic" and is displayed in a dedicated section. A count-up timer shows how long the current topic has been under discussion. The current topic determines whether the "Reply" queue entry type is available, and the reply form references the current topic by name.

### Timers

The Queue tab displays live count-up timers on three elements:

- **Current agenda item** — time since the agenda item started. If the item has a timebox, the timer turns bold red when the timebox is exceeded.
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

During an active poll, all participants see a modal with the poll topic (if provided), a count-up timer showing how long the poll has been open, and a panel of buttons — one for each option — showing the emoji, label, and reaction count. Clicking a button toggles the user's reaction (adds if not present, removes if already selected). In single-select mode, selecting a new option automatically deselects the previous one. Each button shows how many participants have selected it. Hovering over a button shows the names of the participants who reacted. The user's own selected reactions are visually highlighted.

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

| Event                    | Logged when                                                                                                              | Description format                                              | Additional data                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Meeting started**      | Chair advances to the first agenda item                                                                                  | "Meeting started"                                               | —                                                                                                                                                                                                                                                        |
| **Agenda item started**  | Chair advances to a new agenda item                                                                                      | "Started: _item name_"                                          | Item owner (initial speaker)                                                                                                                                                                                                                             |
| **Agenda item finished** | Chair advances past an agenda item (i.e. the next item starts, completing the previous one)                              | "Finished: _item name_"                                         | Duration, participant summary (all distinct users who spoke during the item, excluding any Point of Order speakers), remaining queue (text serialisation of any entries left in the queue when the item was advanced, shown in a collapsible disclosure) |
| **Topic discussed**      | Chair advances the speaker, and the new speaker's entry type is "New Topic" or the agenda item owner's introductory turn | Topic name with speaker's user badge inline                     | Total topic duration, list of reply/clarification speakers with their durations (see Speaker Grouping below)                                                                                                                                             |
| **Poll ran**             | Chair stops a poll                                                                                                       | "Ran a poll" (or "Ran a poll: _topic_" if a topic was provided) | Chair who ran it (or both chairs if different people started and stopped), poll topic (if provided), duration, total number of voters, results summary (each option's emoji, label, and count)                                                           |

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

The **Export** button downloads a Markdown file (named `{meeting-id}-{epoch-seconds}.md`) containing the full meeting log in chronological order (oldest events first). Agenda items are rendered as headings, speaker topics as nested lists with entry types in bold, and poll results as lists. All timestamps are UTC. The file ends with a **Participants** summary table listing every user who spoke during the meeting, sorted by total speaking time (descending). The button is hidden when the log is empty and in presentation mode.

### Persistence

The log is permanent and cannot be edited or deleted during the meeting's lifetime. It is available to all connected participants and updated in real time.

## User Identity Display

Wherever a user's name is shown (agenda item owners, queue entry speakers, current speaker, chairs list, poll tooltips, navigation bar), their GitHub avatar is displayed alongside their name and organisation. Avatars are loaded from GitHub and hidden gracefully if the image fails to load.

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

The hamburger menu in the top-right navigation contains a **Preferences** entry that opens a modal for user-facing settings. The modal can also be toggled with the `,` keyboard shortcut. Changes are saved immediately to `localStorage` and applied right away — there is no explicit Save button. Current preferences:

- **Keyboard shortcuts** — enable or disable global keyboard shortcuts. Mirrors the toggle inside the `?` dialog; both locations read and write the same value.
- **Notifications** — a top-level toggle plus four per-event toggles (see the Notifications section below).
- **Colour scheme** — choose Light, Dark, or System. System (the default) follows the operating system's `prefers-color-scheme`; Light and Dark override it.

## Notifications

Browser-native notifications can be enabled from the Preferences modal. The top-level **Notifications** toggle is off by default; the first time the user switches it on, the browser prompts for permission. If permission is granted, the toggle stays on. Per-event sub-toggles default to on, except for the two chair-oriented ones (point of order and agenda-item overrun) which default to off:

- **When your queue entry is next** — a queue entry you authored has reached the head of the queue.
- **When your agenda item is next** — the agenda item immediately after the current one is owned by you.
- **When the meeting has started** — fires once when the first agenda item becomes active. Mutually exclusive with "agenda advances" — only the meeting-started notification fires on the initial transition.
- **When the agenda advances** — the current agenda item has changed after the meeting is already underway.
- **When a poll has started** — a chair has opened a new poll. The chair who started the poll is not notified about their own action.
- **When a clarifying question is raised on your topic** — you are the current topic author, and someone else has queued a clarifying question. You are not notified about your own questions.
- **When a point of order is raised** — another participant has added a point-of-order entry. The author of a point of order is not notified about their own. Off by default.
- **When the current agenda item exceeds its time estimate** — a time-based notification that fires once, the moment the current agenda item crosses its timebox. Skipped if the item was already overrun when the page loaded. Off by default.

If the user denies permission at the browser prompt (or permission was already denied for the site), the top-level toggle silently stays off. If permission is later revoked through browser settings, the next in-page transition detects the change, self-heals the preference back to off, and no notification is fired. Notifications fire regardless of whether the tab is in the foreground.

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

## Real-Time Updates

All meeting state changes are broadcast to all connected participants in real time. This includes:

- Agenda item additions, edits, deletions, and reordering
- Queue additions, edits, deletions, and reordering
- Current speaker and current topic changes
- Agenda item advancement
- Poll state, options, and reactions
- Log entries for significant meeting events

A small connection status indicator is displayed in the bottom-right corner of the meeting page: green when connected to the server, red when disconnected. This helps participants know whether they are seeing live state. While connected, hovering the indicator reveals the current number of active connections to the meeting.

## Error Handling

- Fatal errors (e.g. "Meeting not found") are shown as a full-page error with a link back to the home page.
- Non-fatal errors (e.g. "Only chairs can...") are shown as a dismissible red banner at the top of the meeting page.

## Persistence

Meeting state is persisted and survives server restarts. Meetings are automatically deleted 90 days after their most recent client connection.
