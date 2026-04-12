/**
 * Queue tab panel — displays the current agenda item, current speaker,
 * speaker controls, and the speaker queue.
 *
 * The agenda item section shows Start Meeting / Next Agenda Item buttons
 * for chairs. The speaker section shows the current speaker with a
 * Next Speaker button for chairs. Below that are the entry type buttons
 * and the queue list with per-entry controls.
 */

import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { useAdvanceAction } from '../hooks/useAdvanceAction.js';
import { SpeakerControls } from './SpeakerControls.js';

export function QueuePanel() {
  const { meeting, user } = useMeetingState();
  const isChair = useIsChair();
  const socket = useSocket();

  // Advancement actions with automatic retry on stale version
  const handleNextAgendaItem = useAdvanceAction('meeting:nextAgendaItem');
  const handleNextSpeaker = useAdvanceAction('queue:next');

  if (!meeting) return null;

  /** Remove a queue entry (own entry, or any entry if chair). */
  function handleRemoveEntry(entryId: string) {
    socket?.emit('queue:remove', { id: entryId });
  }

  /**
   * Move a queue entry up one position. Resolves the adjacent entry's
   * UUID so the server receives a UUID-based reorder (not index-based),
   * avoiding race conditions.
   */
  function handleMoveUp(index: number) {
    if (!meeting || index <= 0) return;
    const entry = meeting.queuedSpeakers[index];
    // To move up, place after the entry two positions above (or at
    // the beginning if moving to position 0)
    const afterId = index >= 2 ? meeting.queuedSpeakers[index - 2].id : null;
    socket?.emit('queue:reorder', { id: entry.id, afterId });
  }

  /**
   * Move a queue entry down one position. Resolves the adjacent entry's
   * UUID so the server receives a UUID-based reorder (not index-based).
   */
  function handleMoveDown(index: number) {
    if (!meeting || index >= meeting.queuedSpeakers.length - 1) return;
    const entry = meeting.queuedSpeakers[index];
    // To move down, place after the entry currently below
    const afterId = meeting.queuedSpeakers[index + 1].id;
    socket?.emit('queue:reorder', { id: entry.id, afterId });
  }

  // Determine whether there are more agenda items after the current one
  const hasMoreAgendaItems = (() => {
    if (!meeting.currentAgendaItem) {
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

              {/* Next Agenda Item button — chair only */}
              {isChair && hasMoreAgendaItems && (
                <button
                  onClick={handleNextAgendaItem}
                  className="ml-3 border border-stone-300 rounded px-2 py-0.5 text-xs
                             text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer"
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
            {/* Start Meeting button — chair only */}
            {isChair && meeting.agenda.length > 0 && (
              <button
                onClick={handleNextAgendaItem}
                className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                           text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
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

            {/* Next Speaker button — chair only */}
            {isChair && (
              <button
                onClick={handleNextSpeaker}
                className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                           text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              >
                Next Speaker
              </button>
            )}
          </div>
        ) : (
          <div>
            <p className="text-stone-500">
              Nobody speaking yet&hellip; enter the queue to get started
            </p>

            {/* Next Speaker button when nobody is speaking — starts from queue */}
            {isChair && meeting.queuedSpeakers.length > 0 && (
              <button
                onClick={handleNextSpeaker}
                className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                           text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              >
                Next Speaker
              </button>
            )}
          </div>
        )}
      </section>

      {/* --- Speaker Entry Controls --- */}
      <SpeakerControls />

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
            {meeting.queuedSpeakers.map((entry, index) => {
              // Show delete for own entries or if chair
              const isOwnEntry = user && entry.user.ghid === user.ghid;
              const canDelete = isOwnEntry || isChair;

              return (
                <li key={entry.id} className="flex items-center gap-2 border-b border-stone-100 pb-2">
                  {/* Reorder arrows — chair only, to the left of the number */}
                  {isChair && (
                    <div className="flex flex-col items-center w-4">
                      {index > 0 ? (
                        <button
                          onClick={() => handleMoveUp(index)}
                          className="text-stone-300 hover:text-stone-700 transition-colors
                                     cursor-pointer leading-none"
                          aria-label={`Move up: ${entry.topic}`}
                        >
                          ▲
                        </button>
                      ) : (
                        <span className="invisible">▲</span>
                      )}
                      {index < meeting.queuedSpeakers.length - 1 ? (
                        <button
                          onClick={() => handleMoveDown(index)}
                          className="text-stone-300 hover:text-stone-700 transition-colors
                                     cursor-pointer leading-none"
                          aria-label={`Move down: ${entry.topic}`}
                        >
                          ▼
                        </button>
                      ) : (
                        <span className="invisible">▼</span>
                      )}
                    </div>
                  )}

                  {/* Position number */}
                  <span className="text-lg font-semibold text-stone-400 tabular-nums min-w-[1.5rem] text-right">
                    {index + 1}
                  </span>

                  <div className="flex-1 min-w-0">
                    {/* Type badge and topic */}
                    <span className={`text-sm font-semibold ${entryTypeColor(entry.type)}`}>
                      {entryTypeLabel(entry.type)}:
                    </span>
                    <span className="ml-1 text-stone-800">{entry.topic}</span>

                    {/* Speaker info and action buttons */}
                    <p className="text-sm text-stone-500">
                      {entry.user.name}
                      {entry.user.organisation && (
                        <> ({entry.user.organisation})</>
                      )}

                      {/* Delete button — own entries or chair */}
                      {canDelete && (
                        <button
                          onClick={() => handleRemoveEntry(entry.id)}
                          className="ml-3 text-xs text-stone-400 hover:text-red-600
                                     transition-colors cursor-pointer"
                          aria-label={`Delete entry: ${entry.topic}`}
                        >
                          Delete
                        </button>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
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
