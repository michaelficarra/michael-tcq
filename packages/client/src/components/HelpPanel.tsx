/**
 * Help tab panel — explains how TCQ works for both chairs and participants.
 */

export function HelpPanel() {
  return (
    <div id="panel-help" role="tabpanel" aria-label="Help" className="p-6 max-w-3xl">
      <h2 className="text-lg font-semibold text-stone-800 mb-4">How to Use TCQ</h2>

      <p className="text-stone-600 mb-6">
        TCQ is a discussion queue for agenda-driven meetings. It helps structure
        conversation by letting participants line up to speak, organised by topic
        type and priority, while chairs control the flow of the meeting.
      </p>

      {/* --- For Everyone --- */}
      <section className="mb-8">
        <h3 className="text-base font-semibold text-stone-800 mb-3 border-b border-stone-200 pb-1">
          For Everyone
        </h3>

        <h4 className="font-medium text-stone-700 mt-4 mb-1">Joining a Meeting</h4>
        <p className="text-sm text-stone-600 mb-3">
          Enter the meeting ID on the home page or follow a direct link. Once
          joined, you'll see the meeting's agenda and speaker queue in real time.
        </p>

        <h4 className="font-medium text-stone-700 mt-4 mb-1">Entering the Queue</h4>
        <p className="text-sm text-stone-600 mb-2">
          On the <strong>Queue</strong> tab, click one of the entry type buttons
          to join the speaker queue. You'll be added immediately with a
          placeholder topic, and the topic field will open for editing so you
          can type a more specific description. Your entry appears in the queue
          for everyone to see in real time.
        </p>
        <p className="text-sm text-stone-600 mb-2">
          There are four entry types, listed from highest to lowest priority:
        </p>
        <ul className="text-sm text-stone-600 ml-4 mb-3 space-y-1 list-disc">
          <li>
            <strong className="text-red-600">Point of Order</strong> — for
            procedural matters that need immediate attention (e.g. "we're over
            time", "the presenter should share their screen"). Use sparingly.
          </li>
          <li>
            <strong className="text-green-600">Clarifying Question</strong> — for
            brief factual questions about what was just said. Not for expressing
            opinions or raising new discussion points.
          </li>
          <li>
            <strong className="text-cyan-600">Reply</strong> — to respond
            directly to the current topic being discussed. Only available when
            there is an active topic. Use this to stay on-topic rather than
            raising a new thread.
          </li>
          <li>
            <strong className="text-blue-600">New Topic</strong> — to raise a
            new line of discussion. This has the lowest priority, so points of
            order, questions, and replies will be addressed first.
          </li>
        </ul>
        <p className="text-sm text-stone-600 mb-2">
          You can edit or delete your own queue entries at any time by clicking
          the <strong>Edit</strong> or <strong>Delete</strong> buttons on your entry.
          You can also click the type label (e.g. "New Topic:") to cycle
          through the types that are legal at that position.
        </p>
        <p className="text-sm text-stone-600 mb-3">
          You can drag your own entries downward to defer your position in
          the queue (e.g. to let someone else speak first). You cannot drag
          upward — only chairs can promote entries.
        </p>

        <h4 className="font-medium text-stone-700 mt-4 mb-1">Temperature Checks</h4>
        <p className="text-sm text-stone-600 mb-3">
          When a chair starts a temperature check, a panel of reaction buttons
          appears. Click any button to indicate your sentiment — click it again
          to remove your reaction. You can select multiple options. Hover over a
          button to see who else has reacted.
        </p>
      </section>

      {/* --- For Chairs --- */}
      <section className="mb-8">
        <h3 className="text-base font-semibold text-stone-800 mb-3 border-b border-stone-200 pb-1">
          For Chairs
        </h3>

        <h4 className="font-medium text-stone-700 mt-4 mb-1">Creating a Meeting</h4>
        <p className="text-sm text-stone-600 mb-3">
          On the home page, enter the GitHub usernames of the chairs
          (comma-separated) and click <strong>Start a New Meeting</strong>. Share
          the resulting meeting ID or URL with participants.
        </p>

        <h4 className="font-medium text-stone-700 mt-4 mb-1">Managing the Agenda</h4>
        <p className="text-sm text-stone-600 mb-3">
          On the <strong>Agenda</strong> tab, click <strong>+ New Agenda
          Item</strong> to add items. Each item has a name, an owner (the person
          who will present it), and an optional timebox in minutes. Drag items to
          reorder them. Click <strong>edit</strong> or <strong>delete</strong> to
          modify or remove items.
        </p>

        <h4 className="font-medium text-stone-700 mt-4 mb-1">Running the Meeting</h4>
        <p className="text-sm text-stone-600 mb-2">
          Switch to the <strong>Queue</strong> tab to run the meeting:
        </p>
        <ol className="text-sm text-stone-600 ml-4 mb-3 space-y-1 list-decimal">
          <li>
            Click <strong>Start Meeting</strong> to advance to the first agenda
            item. The item's owner becomes the current speaker.
          </li>
          <li>
            As participants enter the queue, click <strong>Next Speaker</strong>
            to advance through them. The queue automatically orders entries by
            priority.
          </li>
          <li>
            When discussion on an item is complete, click <strong>Next Agenda
            Item</strong> to move on. The queue is cleared and the next item's
            owner becomes the speaker.
          </li>
        </ol>
        <p className="text-sm text-stone-600 mb-2">
          You can also drag queue entries to reorder them manually. When an
          entry is moved, its type adjusts to stay consistent with the
          priority ordering of its neighbours.
        </p>
        <p className="text-sm text-stone-600 mb-2">
          You (or the entry's author) can click the type label
          (e.g. "New Topic:") on a queue entry to cycle through the types
          that are legal at that position. This lets you change an entry's
          type without moving it — for example, changing a "New Topic" to a
          "Clarifying Question" if the ordering allows it.
        </p>
        <p className="text-sm text-stone-600 mb-3">
          You can edit or delete any queue entry.
        </p>

        <h4 className="font-medium text-stone-700 mt-4 mb-1">Temperature Checks</h4>
        <p className="text-sm text-stone-600 mb-2">
          To gauge the room's sentiment on a topic:
        </p>
        <ol className="text-sm text-stone-600 ml-4 mb-3 space-y-1 list-decimal">
          <li>
            Click <strong>Check Temperature</strong> in the agenda item section.
          </li>
          <li>
            A setup form appears with default response options. You can add,
            remove, or customise the options (each has an emoji and a label).
          </li>
          <li>
            Click <strong>Start Temperature Check</strong>. All participants see
            the reaction buttons and can respond.
          </li>
          <li>
            Click <strong>Copy Results</strong> to copy a summary to your
            clipboard.
          </li>
          <li>
            Click <strong>Stop Temperature Check</strong> when done.
          </li>
        </ol>
      </section>

      {/* --- Tips --- */}
      <section>
        <h3 className="text-base font-semibold text-stone-800 mb-3 border-b border-stone-200 pb-1">
          Tips
        </h3>
        <ul className="text-sm text-stone-600 ml-4 space-y-2 list-disc">
          <li>
            Use <strong>Reply</strong> to stay on the current topic rather than
            opening a new thread with <strong>New Topic</strong>. This keeps
            discussions focused.
          </li>
          <li>
            Reserve <strong>Point of Order</strong> for procedural matters, not
            for expressing opinions. It jumps to the front of the queue.
          </li>
          <li>
            Use <strong>Clarifying Question</strong> only for brief factual
            questions. If your question will lead to extended discussion, use
            <strong> New Topic</strong> instead.
          </li>
          <li>
            All changes are synced in real time — there's no need to refresh the
            page.
          </li>
        </ul>
      </section>
    </div>
  );
}
