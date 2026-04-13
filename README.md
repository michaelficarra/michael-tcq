# TCQ — A Structured Meeting Queue

TCQ is a real-time web application for managing structured discussions during agenda-driven meetings. It provides a shared queue where participants can line up to speak, organised by topic type and priority, while chairs control the flow of the meeting.

## Improvements Over the Original TCQ

This project is a clean-room reimplementation inspired by [the original TCQ](https://github.com/bterlson/tcq). Notable improvements include:

- **Instant queue entry** — clicking a queue type button immediately adds you to the queue with a placeholder topic, then opens inline editing. No modal form to fill out before joining.
- **Queue copy and restore** — chairs can copy the entire queue as text and paste it back later, preserving the original authors. Useful for saving and restoring queue state across breaks.
- **Customisable temperature checks** — temperature check options are fully configurable per check. Chairs can add, remove, and customise the emoji and label for each option, rather than being limited to a fixed set. Results can be copied to the clipboard.
- **Participant queue self-management** — participants can drag their own entries downward to defer, edit their own topics inline, and click the type badge to cycle through legal types at their position.
- **Type cycling** — chairs (and entry owners) can click the type badge on a queue entry to cycle through the types that are legal at that position without moving the entry.
- **Directional type changes** — when dragging entries, the type adjusts based on direction: moving down adopts the lowest priority of items above, moving up adopts the highest priority of items below.
- **Keyboard shortcuts** — press `?` to see all shortcuts. Quick keys for entering the queue (`n`, `r`, `c`, `p`), advancing the speaker (`s`), switching tabs (`a`, `q`), and toggling presentation mode (`f`).
- **Presentation mode** — press `f` to enter fullscreen with all controls hidden, ideal for projecting the queue during a meeting.
- **In-app help page** — a Help tab explains how the tool works for both chairs and participants, with guidance on when to use each queue entry type.
- **Inline editing** — agenda items and queue entries can be edited in place without needing to delete and re-create.
- **GitHub avatars** — user avatars are shown alongside names throughout the application.
- **Visual queue indicators** — point-of-order entries are highlighted with a red border and background. A user's own queue entries are shown with a teal left border.
- **Race condition prevention** — advancement events use a version counter with automatic client-side retry. Reordering uses UUID-based positioning instead of array indices.
- **Error display** — server errors are shown as a dismissible banner or a full-page error (e.g. "Meeting not found") rather than silently failing.
- **Mock auth mode** — a built-in dev user-switcher allows testing with multiple identities without configuring GitHub OAuth.
- **Editable chair list** — chairs can edit the list of chairs from the Agenda tab during a meeting, adding or removing others (but not themselves).
- **Admin dashboard** — admins (configured via `ADMIN_USERNAMES` env var) see a list of all active meetings on the home page with connection statistics, and can delete meetings.
- **Confirmation on agenda advancement** — advancing to the next agenda item prompts for confirmation when the queue is non-empty, preventing accidental queue loss.
- **Sticky navigation** — the navigation bar stays fixed at the top of the page when scrolling long agendas or queues.
- **Memorable meeting IDs** — meetings use human-readable word-based IDs (e.g. `bright-pine-lake`) instead of opaque random strings.
- **Modern, familiar tech stack** — built with React, Vite, Tailwind CSS, Express, and Socket.IO — widely known technologies that lower the contribution barrier. TypeScript throughout with strict mode.
- **Easy local development** — `npm install && npm run dev` is all that's needed to start developing. No Docker, no external databases, no OAuth setup required. Mock auth is automatic. A seed script populates a meeting with sample data for quick testing. An extensive test suite covers server logic, socket events, permissions, and UI components.
- **Well documented** — comprehensive docs covering [local development](docs/CONTRIBUTING.md), [production deployment](docs/DEPLOYMENT.md), [architecture decisions](docs/ARCHITECTURE.md), and a complete [product requirements document](docs/PRD.md).

## Quick Start

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for local development setup.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production deployment instructions.
