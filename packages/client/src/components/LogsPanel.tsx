/**
 * Logs tab panel — displays a reverse-chronological timeline of meeting
 * events: agenda item changes, speaker topic groups, and polls.
 *
 * Speaker changes are grouped by topic: replies and clarifying questions
 * appear nested under the topic they relate to. Topics with a single
 * speaker (no replies/clarifications) use a compact inline format.
 */

import { useState, useEffect } from 'react';
import type { LogEntry, TopicSpeaker, User } from '@tcq/shared';
import { QUEUE_ENTRY_LABELS } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';
import { UserBadge } from './UserBadge.js';
import { InlineMarkdown } from './InlineMarkdown.js';

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

/**
 * Format a full timestamp for the tooltip, using the viewer's locale and
 * time zone. e.g. "13 April 2026, 14:32:07" or "4/13/2026, 2:32:07 PM".
 */
function formatFullTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Compute a relative time string like "5 minutes ago". */
function relativeTime(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  const seconds = Math.round(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// -- Relative time component --

function RelativeTime({ timestamp }: { timestamp: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <time
      dateTime={timestamp}
      title={formatFullTimestamp(timestamp)}
      className="text-xs text-stone-400 dark:text-stone-500 whitespace-nowrap"
    >
      {relativeTime(timestamp, now)}
    </time>
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
      <span className="text-xs text-stone-400 dark:text-stone-500 shrink-0">
        {label}:
      </span>
      <span className="text-sm text-stone-600 dark:text-stone-300">
        <InlineMarkdown>{speaker.topic}</InlineMarkdown>
      </span>
      {speaker.duration !== undefined && (
        <span className="text-xs text-stone-400 dark:text-stone-500 shrink-0">
          {formatDuration(speaker.duration)}
        </span>
      )}
      <UserBadge user={users[speaker.userId]} size={18} className="text-sm text-stone-700 dark:text-stone-200 shrink-0" />
    </div>
  );
}

// -- Individual log entry renderers --

function MeetingStartedEntry({ entry }: { entry: LogEntry & { type: 'meeting-started' } }) {
  return (
    <div className="flex items-center gap-2">
      <RelativeTime timestamp={entry.timestamp} />
      <span className="text-sm font-medium text-stone-800 dark:text-stone-200">
        Meeting started
      </span>
    </div>
  );
}

function AgendaItemStartedEntry({ entry, users }: { entry: LogEntry & { type: 'agenda-item-started' }; users: Record<string, User> }) {
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <RelativeTime timestamp={entry.timestamp} />
        <span className="text-sm text-stone-800 dark:text-stone-200">
          <span className="font-medium">Started:</span> <InlineMarkdown>{entry.itemName}</InlineMarkdown>
        </span>
        <UserBadge user={users[entry.itemOwnerId]} size={18} className="text-xs text-stone-500 dark:text-stone-400 shrink-0" />
      </div>
    </div>
  );
}

function AgendaItemFinishedEntry({ entry, users }: { entry: LogEntry & { type: 'agenda-item-finished' }; users: Record<string, User> }) {
  return (
    <div className="flex items-start gap-2">
      <RelativeTime timestamp={entry.timestamp} />
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-stone-800 dark:text-stone-200">
            <span className="font-medium">Finished:</span> <InlineMarkdown>{entry.itemName}</InlineMarkdown>
          </span>
          <span className="text-xs text-stone-400 dark:text-stone-500">
            {formatDuration(entry.duration)}
          </span>
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

function TopicDiscussedEntry({ entry, users }: { entry: LogEntry & { type: 'topic-discussed' }; users: Record<string, User> }) {
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
          <span className="text-xs text-stone-400 dark:text-stone-500">
            {formatDuration(entry.duration)}
          </span>
          <UserBadge user={users[speaker.userId]} size={18} className="text-sm text-stone-700 dark:text-stone-200 shrink-0" />
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
        <span className="text-xs text-stone-400 dark:text-stone-500">
          {formatDuration(entry.duration)}
        </span>
        <UserBadge user={users[firstSpeaker.userId]} size={18} className="text-sm text-stone-700 dark:text-stone-200 shrink-0" />
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
            Ran a poll
          </span>
          <span className="text-xs text-stone-400 dark:text-stone-500">
            {formatDuration(entry.duration)}
          </span>
          <span className="text-xs text-stone-500 dark:text-stone-400">
            {entry.totalVoters} voter{entry.totalVoters !== 1 ? 's' : ''}
          </span>
          {sameChair ? (
            <UserBadge user={users[entry.startChairId]} size={18} className="text-sm text-stone-700 dark:text-stone-200 shrink-0" />
          ) : (
            <>
              <UserBadge user={users[entry.startChairId]} size={18} className="text-sm text-stone-700 dark:text-stone-200 shrink-0" />
              <UserBadge user={users[entry.endChairId]} size={18} className="text-sm text-stone-700 dark:text-stone-200 shrink-0" />
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
          <UserBadge user={users[speaker.userId]} size={18} className="text-sm text-stone-700 dark:text-stone-200 shrink-0" />
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
        <UserBadge user={users[speakers[0].userId]} size={18} className="text-sm text-stone-700 dark:text-stone-200 shrink-0" />
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
      return <MeetingStartedEntry entry={entry} />;
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

// -- Main component --

export function LogsPanel() {
  const { meeting } = useMeetingState();

  if (!meeting) return null;

  const reversedLog = [...meeting.log].reverse();
  const hasCurrentTopic = meeting.currentTopicSpeakers.length > 0;
  const isEmpty = reversedLog.length === 0 && !hasCurrentTopic;

  return (
    <div role="tabpanel" aria-label="Logs" className="p-4 sm:p-6 max-w-3xl mx-auto">
      {isEmpty && (
        <p className="text-stone-500 dark:text-stone-400 text-sm">
          No events yet. The log will populate as the meeting progresses.
        </p>
      )}

      <div className="space-y-4">
        {/* Current (ongoing) topic group at the top */}
        {hasCurrentTopic && <CurrentTopicGroup speakers={meeting.currentTopicSpeakers} users={meeting.users} />}

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
