/**
 * Queue tab panel — displays the current agenda item, current speaker,
 * speaker controls, and the speaker queue.
 *
 * For now this is a read-only shell showing placeholder states.
 * Interactive features will be added in Steps 6–8.
 */

import { useMeetingState } from '../contexts/MeetingContext.js';

export function QueuePanel() {
  const { meeting } = useMeetingState();

  if (!meeting) return null;

  return (
    <div id="panel-queue" role="tabpanel" aria-label="Queue" className="p-6 space-y-6">
      {/* --- Agenda Item Section --- */}
      <section aria-labelledby="agenda-item-heading">
        <h2
          id="agenda-item-heading"
          className="text-xs font-bold uppercase tracking-wider text-blue-600 mb-1"
        >
          Agenda Item
        </h2>

        {meeting.currentAgendaItem ? (
          <div>
            <p className="text-stone-800 font-medium">
              {meeting.currentAgendaItem.name}
            </p>
            <p className="text-sm text-stone-500">
              {meeting.currentAgendaItem.owner.name}
              {meeting.currentAgendaItem.owner.organisation && (
                <> ({meeting.currentAgendaItem.owner.organisation})</>
              )}
              {meeting.currentAgendaItem.timebox != null && meeting.currentAgendaItem.timebox > 0 && (
                <span className="ml-2">
                  {meeting.currentAgendaItem.timebox}{' '}
                  {meeting.currentAgendaItem.timebox === 1 ? 'minute' : 'minutes'}
                </span>
              )}
            </p>
          </div>
        ) : (
          <p className="text-stone-500">
            Waiting for the meeting to start&hellip;
          </p>
        )}
      </section>

      {/* --- Current Topic Section --- */}
      {meeting.currentTopic && (
        <section aria-labelledby="topic-heading">
          <h2
            id="topic-heading"
            className="text-xs font-bold uppercase tracking-wider text-blue-600 mb-1"
          >
            Topic
          </h2>
          <p className="text-stone-800">{meeting.currentTopic.topic}</p>
          <p className="text-sm text-stone-500">
            {meeting.currentTopic.user.name}
            {meeting.currentTopic.user.organisation && (
              <> ({meeting.currentTopic.user.organisation})</>
            )}
          </p>
        </section>
      )}

      {/* --- Current Speaker Section --- */}
      <section aria-labelledby="speaking-heading">
        <h2
          id="speaking-heading"
          className="text-xs font-bold uppercase tracking-wider text-stone-800 mb-1"
        >
          Speaking
        </h2>

        {meeting.currentSpeaker ? (
          <div>
            <p className="text-stone-800 font-medium">
              {meeting.currentSpeaker.user.name}
              {meeting.currentSpeaker.user.organisation && (
                <span className="font-normal text-stone-500">
                  {' '}({meeting.currentSpeaker.user.organisation})
                </span>
              )}
            </p>
            <p className="text-sm text-stone-500">
              {meeting.currentSpeaker.topic}
            </p>
          </div>
        ) : (
          <p className="text-stone-500">
            Nobody speaking yet&hellip; enter the queue to get started
          </p>
        )}
      </section>

      {/* --- Speaker Queue Section --- */}
      <section aria-labelledby="queue-heading">
        <h2
          id="queue-heading"
          className="text-xs font-bold uppercase tracking-wider text-stone-800 mb-1"
        >
          Speaker Queue
        </h2>

        {meeting.queuedSpeakers.length === 0 ? (
          <p className="text-stone-400 italic text-sm">The queue is empty.</p>
        ) : (
          <ol className="space-y-3">
            {meeting.queuedSpeakers.map((entry, index) => (
              <li key={entry.id} className="flex items-baseline gap-3">
                {/* Position number */}
                <span className="text-lg font-semibold text-stone-400 tabular-nums min-w-[1.5rem] text-right">
                  {index + 1}
                </span>

                <div>
                  {/* Type badge and topic */}
                  <span className={`text-sm font-semibold ${entryTypeColor(entry.type)}`}>
                    {entryTypeLabel(entry.type)}:
                  </span>
                  <span className="ml-1 text-stone-800">{entry.topic}</span>

                  {/* Speaker info */}
                  <p className="text-sm text-stone-500">
                    {entry.user.name}
                    {entry.user.organisation && (
                      <> ({entry.user.organisation})</>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** Map a queue entry type to its display label. */
function entryTypeLabel(type: string): string {
  switch (type) {
    case 'topic': return 'New Topic';
    case 'reply': return 'Reply';
    case 'question': return 'Clarifying Question';
    case 'point-of-order': return 'Point of Order';
    default: return type;
  }
}

/** Map a queue entry type to a Tailwind text colour class. */
function entryTypeColor(type: string): string {
  switch (type) {
    case 'topic': return 'text-blue-600';
    case 'reply': return 'text-cyan-600';
    case 'question': return 'text-green-600';
    case 'point-of-order': return 'text-red-600';
    default: return 'text-stone-600';
  }
}
