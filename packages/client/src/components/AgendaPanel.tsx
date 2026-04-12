/**
 * Agenda tab panel — displays the ordered list of agenda items.
 *
 * For now this is a read-only shell. Interactive features (add, delete,
 * reorder) will be added in Step 5.
 */

import { useMeetingState } from '../contexts/MeetingContext.js';

export function AgendaPanel() {
  const { meeting } = useMeetingState();

  if (!meeting) return null;

  return (
    <div id="panel-agenda" role="tabpanel" aria-label="Agenda" className="p-6">
      {meeting.agenda.length === 0 ? (
        <p className="text-stone-400 italic">No agenda items yet.</p>
      ) : (
        <ol className="space-y-4">
          {meeting.agenda.map((item, index) => (
            <li
              key={item.id}
              className="flex items-baseline gap-3 border-b border-stone-100 pb-3"
            >
              {/* Item number */}
              <span className="text-lg font-semibold text-stone-400 tabular-nums min-w-[1.5rem] text-right">
                {index + 1}
              </span>

              <div>
                {/* Item name */}
                <span className="font-medium text-stone-800">
                  {item.name}
                </span>

                {/* Owner */}
                <span className="ml-2 text-sm text-stone-500">
                  {item.owner.name}
                  {item.owner.organisation && (
                    <> ({item.owner.organisation})</>
                  )}
                </span>

                {/* Timebox */}
                {item.timebox != null && item.timebox > 0 && (
                  <span className="ml-2 text-sm text-stone-400">
                    {item.timebox} {item.timebox === 1 ? 'minute' : 'minutes'}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
