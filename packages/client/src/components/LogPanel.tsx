/**
 * Logs tab panel — displays a reverse-chronological timeline of meeting
 * events: agenda item changes, speaker topic groups, and polls.
 *
 * Speaker changes are grouped by topic: replies and clarifying questions
 * appear nested under the topic they relate to. Topics with a single
 * speaker (no replies/clarifications) use a compact inline format.
 */

import { useMemo } from 'react';
import type { LogEntry, MeetingState, TopicSpeaker, User } from '@tcq/shared';
import { QUEUE_ENTRY_LABELS } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';
import { UserBadge } from './UserBadge.js';
import { InlineMarkdown } from './InlineMarkdown.js';
import { RelativeTime as SharedRelativeTime } from '../lib/RelativeTime.js';

// -- Time formatting helpers --

/** Format a duration in ms as a human-readable string (e.g. "12 min", "1 hr 5 min"). */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (remainingMinutes === 0) return `${hours} hr`;
  return `${hours} hr ${remainingMinutes} min`;
}

// -- Relative time component --
// Thin wrapper around the shared <RelativeTime> so log entries get the
// consistent muted styling used throughout this panel without every call
// site having to repeat the className.

function RelativeTime({ timestamp }: { timestamp: string }) {
  return (
    <SharedRelativeTime
      timestamp={timestamp}
      className="text-xs text-stone-400 dark:text-stone-500 whitespace-nowrap"
    />
  );
}

// -- Participant avatars row --

function ParticipantList({ participantIds, users }: { participantIds: string[]; users: Record<string, User> }) {
  if (participantIds.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5">
      <span className="text-xs text-stone-400 dark:text-stone-500 mr-1">Participants:</span>
      {participantIds.map((id) => (
        <UserBadge key={id} user={users[id]} size={18} className="text-xs text-stone-600 dark:text-stone-300" />
      ))}
    </div>
  );
}

// -- Speaker row within a topic group --

function SpeakerRow({ speaker, users }: { speaker: TopicSpeaker; users: Record<string, User> }) {
  const label = QUEUE_ENTRY_LABELS[speaker.type] ?? speaker.type;

  return (
    <div className="flex items-start gap-2 py-1 pl-4 border-l-2 border-stone-200 dark:border-stone-700">
      <span className="text-xs text-stone-400 dark:text-stone-500 shrink-0">{label}:</span>
      <span className="text-sm text-stone-600 dark:text-stone-300">
        <InlineMarkdown>{speaker.topic}</InlineMarkdown>
      </span>
      {speaker.duration !== undefined && (
        <span className="text-xs text-stone-400 dark:text-stone-500 shrink-0">{formatDuration(speaker.duration)}</span>
      )}
      <UserBadge
        user={users[speaker.userId]}
        size={18}
        className="text-sm text-stone-700 dark:text-stone-200 shrink-0"
      />
    </div>
  );
}

// -- Individual log entry renderers --

function MeetingStartedEntry({
  entry,
  users,
}: {
  entry: LogEntry & { type: 'meeting-started' };
  users: Record<string, User>;
}) {
  return (
    <div className="flex items-center gap-2">
      <RelativeTime timestamp={entry.timestamp} />
      <span className="text-sm font-medium text-stone-800 dark:text-stone-200">Meeting started</span>
      <UserBadge
        user={users[entry.chairId]}
        size={18}
        className="text-xs text-stone-500 dark:text-stone-400 shrink-0"
      />
    </div>
  );
}

function AgendaItemStartedEntry({
  entry,
  users,
}: {
  entry: LogEntry & { type: 'agenda-item-started' };
  users: Record<string, User>;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <RelativeTime timestamp={entry.timestamp} />
        <span className="text-sm text-stone-800 dark:text-stone-200">
          <span className="font-medium">Started:</span> <InlineMarkdown>{entry.itemName}</InlineMarkdown>
        </span>
        <UserBadge
          user={users[entry.chairId]}
          size={18}
          className="text-xs text-stone-500 dark:text-stone-400 shrink-0"
        />
      </div>
    </div>
  );
}

function AgendaItemFinishedEntry({
  entry,
  users,
}: {
  entry: LogEntry & { type: 'agenda-item-finished' };
  users: Record<string, User>;
}) {
  return (
    <div className="flex items-start gap-2">
      <RelativeTime timestamp={entry.timestamp} />
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-stone-800 dark:text-stone-200">
            <span className="font-medium">Finished:</span> <InlineMarkdown>{entry.itemName}</InlineMarkdown>
          </span>
          <span className="text-xs text-stone-400 dark:text-stone-500">{formatDuration(entry.duration)}</span>
          <UserBadge
            user={users[entry.chairId]}
            size={18}
            className="text-xs text-stone-500 dark:text-stone-400 shrink-0"
          />
        </div>
        <ParticipantList participantIds={entry.participantIds} users={users} />
        {entry.remainingQueue && (
          <details className="mt-1.5">
            <summary className="text-xs text-stone-400 dark:text-stone-500 cursor-pointer hover:text-stone-600 dark:hover:text-stone-300">
              Remaining queue
            </summary>
            <pre className="text-xs text-stone-500 dark:text-stone-400 mt-1 whitespace-pre-wrap font-mono bg-stone-100 dark:bg-stone-800 rounded p-2">
              {entry.remainingQueue}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function TopicDiscussedEntry({
  entry,
  users,
}: {
  entry: LogEntry & { type: 'topic-discussed' };
  users: Record<string, User>;
}) {
  const isSingleSpeaker = entry.speakers.length === 1;
  const speaker = entry.speakers[0];

  // Compact format: single speaker with no replies/clarifications
  if (isSingleSpeaker) {
    return (
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <RelativeTime timestamp={entry.timestamp} />
          <span className="text-sm text-stone-600 dark:text-stone-300">
            <InlineMarkdown>{entry.topicName}</InlineMarkdown>
          </span>
          <span className="text-xs text-stone-400 dark:text-stone-500">{formatDuration(entry.duration)}</span>
          <UserBadge
            user={users[speaker.userId]}
            size={18}
            className="text-sm text-stone-700 dark:text-stone-200 shrink-0"
          />
        </div>
      </div>
    );
  }

  // Expanded format: heading from the first speaker, remaining speakers nested below
  const firstSpeaker = entry.speakers[0];
  const remainingSpeakers = entry.speakers.slice(1);

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <RelativeTime timestamp={entry.timestamp} />
        <span className="text-sm text-stone-600 dark:text-stone-300">
          <InlineMarkdown>{entry.topicName}</InlineMarkdown>
        </span>
        <span className="text-xs text-stone-400 dark:text-stone-500">{formatDuration(entry.duration)}</span>
        <UserBadge
          user={users[firstSpeaker.userId]}
          size={18}
          className="text-sm text-stone-700 dark:text-stone-200 shrink-0"
        />
      </div>
      <div className="mt-1 space-y-0.5">
        {remainingSpeakers.map((s, i) => (
          <SpeakerRow key={i} speaker={s} users={users} />
        ))}
      </div>
    </div>
  );
}

function PollRanEntry({ entry, users }: { entry: LogEntry & { type: 'poll-ran' }; users: Record<string, User> }) {
  const sameChair = entry.startChairId === entry.endChairId;

  return (
    <div className="flex items-start gap-2">
      <RelativeTime timestamp={entry.timestamp} />
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-stone-800 dark:text-stone-200">
            {entry.topic ? <>Ran a poll: {entry.topic}</> : 'Ran a poll'}
          </span>
          <span className="text-xs text-stone-400 dark:text-stone-500">{formatDuration(entry.duration)}</span>
          <span className="text-xs text-stone-500 dark:text-stone-400">
            {entry.totalVoters} voter{entry.totalVoters !== 1 ? 's' : ''}
          </span>
          {sameChair ? (
            <UserBadge
              user={users[entry.startChairId]}
              size={18}
              className="text-sm text-stone-700 dark:text-stone-200 shrink-0"
            />
          ) : (
            <>
              <UserBadge
                user={users[entry.startChairId]}
                size={18}
                className="text-sm text-stone-700 dark:text-stone-200 shrink-0"
              />
              <UserBadge
                user={users[entry.endChairId]}
                size={18}
                className="text-sm text-stone-700 dark:text-stone-200 shrink-0"
              />
            </>
          )}
        </div>
        <div className="mt-1.5 space-y-0.5">
          {entry.results.map((r) => (
            <div key={r.label} className="text-sm text-stone-600 dark:text-stone-300">
              {r.emoji} {r.label}: {r.count}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// -- Current topic group (not yet finalised) --

function CurrentTopicGroup({ speakers, users }: { speakers: TopicSpeaker[]; users: Record<string, User> }) {
  if (speakers.length === 0) return null;

  const isSingleSpeaker = speakers.length === 1;
  const speaker = speakers[0];

  // Compact format for a single ongoing speaker
  if (isSingleSpeaker) {
    return (
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <RelativeTime timestamp={speaker.startTime} />
          <span className="text-sm text-stone-600 dark:text-stone-300">
            <InlineMarkdown>{speaker.topic}</InlineMarkdown>
          </span>
          <span className="text-xs text-teal-500 font-medium">ongoing</span>
          <UserBadge
            user={users[speaker.userId]}
            size={18}
            className="text-sm text-stone-700 dark:text-stone-200 shrink-0"
          />
        </div>
      </div>
    );
  }

  // Expanded format: heading from the first speaker, remaining speakers nested below
  const remainingSpeakers = speakers.slice(1);

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <RelativeTime timestamp={speakers[0].startTime} />
        <span className="text-sm text-stone-600 dark:text-stone-300">
          <InlineMarkdown>{speakers[0].topic}</InlineMarkdown>
        </span>
        <span className="text-xs text-teal-500 font-medium">ongoing</span>
        <UserBadge
          user={users[speakers[0].userId]}
          size={18}
          className="text-sm text-stone-700 dark:text-stone-200 shrink-0"
        />
      </div>
      <div className="mt-1 space-y-0.5">
        {remainingSpeakers.map((s, i) => (
          <SpeakerRow key={i} speaker={s} users={users} />
        ))}
      </div>
    </div>
  );
}

// -- Log entry dispatcher --

function LogEntryRow({ entry, users }: { entry: LogEntry; users: Record<string, User> }) {
  switch (entry.type) {
    case 'meeting-started':
      return <MeetingStartedEntry entry={entry} users={users} />;
    case 'agenda-item-started':
      return <AgendaItemStartedEntry entry={entry} users={users} />;
    case 'agenda-item-finished':
      return <AgendaItemFinishedEntry entry={entry} users={users} />;
    case 'topic-discussed':
      return <TopicDiscussedEntry entry={entry} users={users} />;
    case 'poll-ran':
      return <PollRanEntry entry={entry} users={users} />;
  }
}

// -- Plain-text export --

function userName(users: Record<string, User>, id: string): string {
  return `@${users[id]?.ghUsername ?? id}`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function serialiseSpeakers(speakers: TopicSpeaker[], users: Record<string, User>): string {
  const lines: string[] = [];
  const first = speakers[0];
  const durationStr = first.duration !== undefined ? ` (${formatDuration(first.duration)})` : ' (ongoing)';
  lines.push(
    `- **${QUEUE_ENTRY_LABELS[first.type]}:** ${first.topic}${durationStr} — ${userName(users, first.userId)}`,
  );
  for (const s of speakers.slice(1)) {
    const dur = s.duration !== undefined ? ` (${formatDuration(s.duration)})` : ' (ongoing)';
    lines.push(`  - **${QUEUE_ENTRY_LABELS[s.type]}:** ${s.topic}${dur} — ${userName(users, s.userId)}`);
  }
  return lines.join('\n');
}

function serialiseLog(meeting: MeetingState): string {
  const lines: string[] = ['# Meeting Log', ''];
  const users = meeting.users;

  for (const entry of meeting.log) {
    switch (entry.type) {
      case 'meeting-started':
        lines.push(`Meeting started — ${userName(users, entry.chairId)} (${formatTimestamp(entry.timestamp)})`);
        lines.push('');
        break;

      case 'agenda-item-started': {
        const presenters = entry.itemPresenterIds.map((id) => userName(users, id)).join(', ');
        const label = entry.itemPresenterIds.length === 1 ? 'Presenter' : 'Presenters';
        lines.push(`## ${entry.itemName}`);
        lines.push('');
        lines.push(
          `${label}: ${presenters} | Started: ${formatTimestamp(entry.timestamp)} | Chair: ${userName(users, entry.chairId)}`,
        );
        lines.push('');
        break;
      }

      case 'agenda-item-finished': {
        const parts = entry.participantIds.map((id) => userName(users, id)).join(', ');
        lines.push(
          `**Finished** (${formatDuration(entry.duration)}, ${entry.participantIds.length} participant${entry.participantIds.length !== 1 ? 's' : ''}) — ${userName(users, entry.chairId)}`,
        );
        if (entry.participantIds.length > 0) {
          lines.push(`Participants: ${parts}`);
        }
        if (entry.remainingQueue) {
          lines.push('');
          lines.push('<details><summary>Remaining queue</summary>');
          lines.push('');
          lines.push('```');
          lines.push(entry.remainingQueue);
          lines.push('```');
          lines.push('');
          lines.push('</details>');
        }
        lines.push('');
        break;
      }

      case 'topic-discussed':
        lines.push(serialiseSpeakers(entry.speakers, users));
        lines.push('');
        break;

      case 'poll-ran': {
        const topic = entry.topic ? `**Poll:** ${entry.topic}` : '**Poll**';
        const chair =
          entry.startChairId === entry.endChairId
            ? userName(users, entry.startChairId)
            : `${userName(users, entry.startChairId)} / ${userName(users, entry.endChairId)}`;
        lines.push(
          `${topic} (${formatDuration(entry.duration)}, ${entry.totalVoters} voter${entry.totalVoters !== 1 ? 's' : ''}) — ${chair}`,
        );
        lines.push('');
        for (const r of entry.results) {
          lines.push(`- ${r.emoji} ${r.label}: ${r.count}`);
        }
        lines.push('');
        break;
      }
    }
  }

  // Current (ongoing) topic speakers
  if (meeting.current.topicSpeakers.length > 0) {
    lines.push(serialiseSpeakers(meeting.current.topicSpeakers, users));
    lines.push('');
  }

  // Participant summary sorted by total speaking time. Seed with every
  // user who has connected via socket (tracked on `participantIds`) so
  // attendees who never spoke still appear in the table with 0s.
  const speakerTotals = new Map<string, number>();
  for (const id of meeting.participantIds) {
    speakerTotals.set(id, 0);
  }
  for (const entry of meeting.log) {
    if (entry.type === 'topic-discussed') {
      for (const s of entry.speakers) {
        speakerTotals.set(s.userId, (speakerTotals.get(s.userId) ?? 0) + (s.duration ?? 0));
      }
    }
  }
  for (const s of meeting.current.topicSpeakers) {
    speakerTotals.set(s.userId, (speakerTotals.get(s.userId) ?? 0) + (s.duration ?? 0));
  }

  if (speakerTotals.size > 0) {
    const sorted = [...speakerTotals.entries()].sort((a, b) => b[1] - a[1]);

    lines.push('## Participants');
    lines.push('');
    lines.push('| Speaker | Time |');
    lines.push('| --- | --- |');
    for (const [id, total] of sorted) {
      const dur = total > 0 ? formatDuration(total) : '0s';
      lines.push(`| ${userName(users, id)} | ${dur} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function downloadFile(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// -- Main component --

export function LogPanel({ hidden = false }: { hidden?: boolean } = {}) {
  const { meeting } = useMeetingState();
  const reversedLog = useMemo(() => (meeting ? [...meeting.log].reverse() : []), [meeting]);

  // When hidden (not the active tab) or meeting state not yet loaded, render
  // only the empty tabpanel shell. Keeping the shell in the DOM avoids the
  // mount/unmount race on tab switch that motivated this refactor; skipping
  // the inner content avoids re-rendering every log entry on every state
  // broadcast for tabs the user isn't currently looking at.
  if (hidden || !meeting) {
    return (
      <div id="panel-log" role="tabpanel" aria-label="Log" hidden={hidden} className="p-4 sm:p-6 max-w-3xl mx-auto" />
    );
  }

  const hasCurrentTopic = meeting.current.topicSpeakers.length > 0;
  const isEmpty = reversedLog.length === 0 && !hasCurrentTopic;

  return (
    <div id="panel-log" role="tabpanel" aria-label="Log" className="p-4 sm:p-6 max-w-3xl mx-auto">
      {isEmpty && (
        <p className="text-stone-500 dark:text-stone-400 text-sm">
          No events yet. The log will populate as the meeting progresses.
        </p>
      )}

      {!isEmpty && (
        <button
          onClick={() => downloadFile(serialiseLog(meeting), `${meeting.id}-${Math.floor(Date.now() / 1000)}.md`)}
          className="float-right ml-4 mb-2 text-xs border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                     text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer presentation-hidden"
        >
          Export
        </button>
      )}

      <div className="space-y-4">
        {/* Current (ongoing) topic group at the top */}
        {hasCurrentTopic && <CurrentTopicGroup speakers={meeting.current.topicSpeakers} users={meeting.users} />}

        {/* Finalised log entries in reverse chronological order */}
        {reversedLog.map((entry, i) => (
          <div key={i}>
            <LogEntryRow entry={entry} users={meeting.users} />
            {entry.type === 'agenda-item-started' && i < reversedLog.length - 1 && (
              <hr className="border-stone-200 dark:border-stone-700 mt-4" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
