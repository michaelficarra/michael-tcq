# TCQ — Product Requirements Document

TCQ is a real-time web application for managing a structured discussion queue during agenda-driven committee meetings. It enables chairs to control the flow of discussion and participants to queue themselves to speak on topics.

## User Roles

### Participants

All authenticated users are participants. They can:

- Join an existing meeting by its meeting ID
- View the agenda and current meeting state (current agenda item, current speaker, queue)
- Add themselves to the speaker queue with a topic description and entry type
- Remove their own entries from the queue
- React during a temperature check

### Chairs

Chairs are designated when a meeting is created. In addition to all participant capabilities, chairs can:

- Create meetings
- Add, delete, and reorder agenda items
- Start the meeting / advance to the next agenda item
- Advance to the next speaker
- Reorder the speaker queue (including moving entries across type boundaries)
- Remove any entry from the speaker queue
- Initiate and stop temperature checks

## Authentication

Users authenticate via GitHub OAuth. Their GitHub display name, username, and organisation are used as their identity within the application.

## Meetings

### Creating a Meeting

An authenticated user creates a meeting by specifying one or more chairs as a comma-separated list of GitHub usernames. The system generates a meeting ID consisting of a short sequence of memorable, easily distinguished words.

### Joining a Meeting

Any authenticated user can join a meeting by entering its meeting ID or by navigating to the meeting's permalink (which includes the meeting ID in the URL). Upon joining, the user receives the full current meeting state and all subsequent real-time updates.

## Agenda

The agenda is an ordered list of items. Each agenda item has:

- **Name** — the title of the item
- **Owner** — a GitHub user who will introduce/present it
- **Timebox** (optional) — a duration in minutes

### Agenda Management (Chair Only)

- **Add** — Create a new agenda item by specifying a name, owner (GitHub username, validated against GitHub), and optional timebox.
- **Delete** — Remove an agenda item.
- **Reorder** — Drag-and-drop to rearrange agenda items.

### Agenda Display

Items are displayed as a numbered list. Each item shows its name, owner (display name and organisation), and timebox duration if set.

## Queue

The queue is the core of the application. It determines who speaks next.

### Queue Entry Types

There are four types of queue entry, listed here from highest to lowest priority:

1. **Point of Order** — procedural matters (displayed in red)
2. **Clarifying Question** — questions for clarification (displayed in green)
3. **Reply** — a response to the current topic being discussed (displayed in blue); only available when there is a current topic
4. **New Topic** — a new line of discussion (displayed in a distinct colour)

When a participant enters the queue, their entry is automatically inserted at the correct position based on type priority. Within the same type, entries are ordered FIFO (first in, first out).

### Entering the Queue

A participant clicks one of the entry type buttons, enters a short topic description, and submits. The entry appears in the queue for all connected users in real time.

### Queue Display

Each queue entry shows:

- Position number
- Type badge (e.g. "New Topic", "Reply", "Clarifying Question", "Point of Order")
- Topic description
- Speaker name and organisation

Chairs additionally see controls to delete, move up, and move down each entry. Participants see a delete button on their own entries only.

### Queue Advancement (Chair or Current Speaker)

- **Next Speaker** (chair action) — the first person in the queue becomes the current speaker; their entry is removed from the queue.
- If the queue is empty when advancement occurs, the current speaker is cleared.

### Queue Reordering (Chair Only)

Chairs can move queue entries up or down. When an entry is moved across a type boundary (e.g. a "New Topic" is moved above a "Clarifying Question"), the entry's type changes to match its new position in the priority order.

## Current Speaker and Current Topic

### Current Speaker

The currently speaking person is displayed prominently, showing their name, organisation, and the topic/question they queued with. Only one person speaks at a time.

### Current Topic

When a speaker introduces a new topic, that topic becomes the "current topic" and is displayed in a dedicated section. The current topic determines whether the "Reply" queue entry type is available, and the reply form references the current topic by name (e.g. "Reply to [topic name]").

## Meeting Flow

1. A chair creates a meeting and shares the meeting ID with participants.
2. Participants join.
3. The chair clicks **Start Meeting**  to advance to the first agenda item. The agenda item's owner automatically becomes the current speaker.
4. Participants enter the queue to discuss the item.
5. The chair advances through the queue.
6. When discussion on an agenda item is complete, the chair clicks **Next Agenda Item** to advance, and the next item's owner becomes the current speaker.
7. This repeats until the agenda is exhausted.

Before the meeting is started, the queue view displays "Waiting for the meeting to start..." with a **Start Meeting** button (visible to chairs).

## Temperature Checks

A temperature check is a lightweight, real-time poll that allows the chair to gauge participant sentiment on the current topic.

### Initiation and Termination (Chair Only)

- **Check Temperature** — starts a temperature check; a reaction panel appears for all participants.
- **Stop Temperature** — ends the temperature check and clears all reactions.

### Reactions

During an active temperature check, participants can react using one or more of the following:

| Reaction | Label |
|----------|-------|
| ❤️ | Strong Positive |
| 👍 | Positive |
| 👀 | Following |
| ❓ | Confused |
| 🤷 | Indifferent |
| 😕 | Unconvinced |

- Each participant can select each reaction type at most once.
- Clicking a reaction again removes it (toggle behaviour).
- Each reaction button shows a count of how many participants have selected it.
- Hovering over a reaction shows the names of the participants who selected it.

## Real-Time Updates

All meeting state changes are broadcast to all connected participants in real time. This includes:

- Agenda item additions, deletions, and reordering
- Queue additions, deletions, and reordering
- Current speaker and current topic changes
- Agenda item advancement
- Temperature check state and reactions

## Navigation

The meeting view has two tabs:

- **Agenda** — displays the ordered list of agenda items with management controls for chairs.
- **Queue** — displays the current agenda item, current topic, current speaker, speaker controls, and the speaker queue.

A top navigation bar shows the TCQ branding, the Agenda/Queue tab toggle, and a Log Out link.
