# TCQ — A Structured Meeting Queue

TCQ is a real-time web application for managing structured discussions during agenda-driven meetings. It provides a shared queue where participants can line up to speak, organised by topic type and priority, while chairs control the flow of the meeting.

> **Status:** In development. Core features are functional with GitHub OAuth authentication. Temperature checks and production deployment are not yet implemented.

## Current Features

- **GitHub authentication** — users log in with their GitHub account. When OAuth is not configured, a mock user is used automatically for local development.
- **Create a meeting** — specify chairs by GitHub username (validated against the GitHub API) and get a shareable meeting ID.
- **Join a meeting** — enter a meeting ID or navigate directly to its URL.
- **Agenda management** — chairs can add, delete, and drag-and-drop reorder agenda items, each with an owner and optional timebox.
- **Meeting flow** — chairs start the meeting and advance through agenda items. The agenda item's owner is automatically set as the current speaker.
- **Speaker queue** — participants enter the queue as New Topic, Clarifying Question, Reply, or Point of Order. Entries are automatically sorted by priority. Chairs advance through speakers and can reorder entries (type changes when crossing priority boundaries). Topic-type entries update the current topic.
- **Real-time updates** — all changes are broadcast instantly to all connected participants.

## Quick Start

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development setup.
