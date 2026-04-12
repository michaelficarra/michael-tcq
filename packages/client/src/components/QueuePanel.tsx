/**
 * Queue tab panel — displays the current agenda item, current speaker,
 * speaker controls, and the speaker queue.
 *
 * The agenda item section shows Start Meeting / Next Agenda Item buttons
 * for chairs. The speaker section shows the current speaker or a
 * placeholder message.
 */

import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';

export function QueuePanel() {
  const { meeting } = useMeetingState();
  const isChair = useIsChair();
  const socket = useSocket();

  if (!meeting) return null;

  /** Chair starts the meeting or advances to the next agenda item. */
  function handleNextAgendaItem() {
    socket?.emit('meeting:nextAgendaItem');
  }

  // Determine whether there are more agenda items after the current one
  const hasMoreAgendaItems = (() => {
    if (!meeting.currentAgendaItem) {
      // Meeting hasn't started — there are items if the agenda is non-empty
      return meeting.agenda.length > 0;
    }
    const currentIndex = meeting.agenda.findIndex(
      (item) => item.id === meeting.currentAgendaItem!.id,
    );
    return currentIndex < meeting.agenda.length - 1;
  })();

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

              {/* Next Agenda Item button — chair only, shown inline */}
              {isChair && hasMoreAgendaItems && (
                <button
                  onClick={handleNextAgendaItem}
                  className="ml-3 border border-stone-300 rounded px-2 py-0.5 text-xs
                             text-stone-600 hover:bg-stone-100 transition-colors"
                >
                  Next Agenda Item
                </button>
              )}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-stone-500">
              Waiting for the meeting to start&hellip;
            </p>
            {/* Start Meeting button — chair only, shown when no current item */}
            {isChair && meeting.agenda.length > 0 && (
              <button
                onClick={handleNextAgendaItem}
                className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                           text-stone-700 hover:bg-stone-100 transition-colors"
              >
                Start Meeting
              </button>
            )}
          </div>
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
          <ol className="space-y-3" aria-label="Queued speakers">
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
export function entryTypeLabel(type: string): string {
  switch (type) {
    case 'topic': return 'New Topic';
    case 'reply': return 'Reply';
    case 'question': return 'Clarifying Question';
    case 'point-of-order': return 'Point of Order';
    default: return type;
  }
}

/** Map a queue entry type to a Tailwind text colour class. */
export function entryTypeColor(type: string): string {
  switch (type) {
    case 'topic': return 'text-blue-600';
    case 'reply': return 'text-cyan-600';
    case 'question': return 'text-green-600';
    case 'point-of-order': return 'text-red-600';
    default: return 'text-stone-600';
  }
}
