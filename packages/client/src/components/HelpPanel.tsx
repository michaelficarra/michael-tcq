/**
 * Help tab panel — explains how TCQ works for participants and (optionally) chairs.
 *
 * When `showChairHelp` is true, additional sections covering chair-only features
 * are displayed. The home page always passes true (since the reader may be about
 * to chair a meeting); the meeting page passes the result of `useIsChair()`.
 */

export function HelpPanel({ showChairHelp }: { showChairHelp: boolean }) {
  return (
    <div id="panel-help" role="tabpanel" aria-label="Help" className="p-6 max-w-3xl">
      <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-4">How to Use TCQ</h2>

      <p className="text-stone-600 dark:text-stone-400 mb-6">
        TCQ is a discussion queue for agenda-driven meetings. It helps structure conversation by letting participants
        line up to speak, organised by topic type and priority, while chairs control the flow of the meeting. All
        changes are synced in real time — there's no need to refresh the page.
      </p>

      {/* ------------------------------------------------------------------ */}
      {/*  For Everyone                                                       */}
      {/* ------------------------------------------------------------------ */}

      <section className="mb-8">
        {showChairHelp && (
          <h3 className="text-base font-semibold text-stone-800 dark:text-stone-200 mb-3 border-b border-stone-200 dark:border-stone-700 pb-1">
            For Everyone
          </h3>
        )}

        <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Joining a Meeting</h4>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
          Enter the meeting ID on the home page or follow a direct link. Once joined, you'll see the meeting's agenda
          and speaker queue in real time. A small dot in the bottom-right corner shows your connection status: green
          when connected, red when disconnected.
        </p>

        <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">The Queue</h4>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
          On the <strong>Queue</strong> tab, click one of the entry type buttons to join the speaker queue. You'll be
          added immediately with a placeholder topic, and the topic field will open for editing so you can type a more
          specific description. If you change your mind, press <strong>Cancel</strong> or the{' '}
          <kbd className="bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 rounded px-1.5 py-0.5 font-mono text-xs">
            Escape
          </kbd>{' '}
          key before changing the topic to remove the entry.
        </p>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
          There are four entry types, listed from highest to lowest priority:
        </p>
        <ul className="text-sm text-stone-600 dark:text-stone-400 ml-4 mb-3 space-y-1 list-disc">
          <li>
            <strong className="text-red-600 dark:text-red-400">Point of Order</strong> — for procedural matters that
            need immediate attention (e.g. "the notes document isn't working", "remote attendees cannot hear the
            presenter"). Use sparingly.
          </li>
          <li>
            <strong className="text-green-600">Clarifying Question</strong> — for brief factual questions about what was
            just said. Not for expressing opinions or raising new discussion points.
          </li>
          <li>
            <strong className="text-cyan-600">Reply</strong> — to respond directly to the current topic being discussed.
            Only available when there is an active topic. Use this to stay on-topic rather than raising a new thread.
          </li>
          <li>
            <strong className="text-blue-600">New Topic</strong> — to raise a new line of discussion. This has the
            lowest priority, so points of order, questions, and replies will be addressed first.
          </li>
        </ul>

        <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
          Your own entries are marked with a teal left border so you can spot them quickly. Point-of-order entries are
          highlighted with a red border and background to reflect their urgency. A chair may close the queue at any time
          to stop accepting new entries — when this happens, the entry type buttons will be disabled. You will be able
          to add entries again once the chair reopens the queue or advances to the next agenda item.
        </p>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
          You can <strong>edit</strong> or <strong>delete</strong> your own queue entries at any time. You can also drag
          your own entries <em>downward</em> to defer your position in the queue (e.g. to let someone else speak first).
          Queue topics support basic markdown: <strong>**bold**</strong>, <em>*italic*</em>,{' '}
          <code className="bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 px-1 rounded text-[0.9em]">
            ~~strikethrough~~
          </code>
          ,{' '}
          <code className="bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 px-1 rounded text-[0.9em]">
            `code`
          </code>
          , and{' '}
          <code className="bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 px-1 rounded text-[0.9em]">
            [links](url)
          </code>
          .
        </p>

        <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">When You&rsquo;re Speaking</h4>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
          When you are the active speaker, an <strong>I&rsquo;m done speaking</strong> button appears next to the
          &ldquo;Speaking&rdquo; heading. Click it to voluntarily yield the floor and advance to the next speaker in the
          queue, without waiting for a chair to do it for you.
        </p>

        <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Polls</h4>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
          When a chair starts a poll, a panel of reaction buttons appears. Click any button to indicate your sentiment —
          click it again to remove your reaction. Depending on how the chair configured the poll, you may be able to
          select multiple options or only one. Hover over a button to see who else has reacted.
        </p>

        <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Meeting Log</h4>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
          The <strong>Log</strong> tab shows a timeline of meeting events: when agenda items started and finished, who
          spoke on each topic (with replies and clarifying questions grouped under their topic), and poll results. Each
          event shows a relative time that you can hover over to see the full timestamp in your local time zone. Click{' '}
          <strong>Export</strong> to download a Markdown transcript of the meeting, including a participant summary
          sorted by total speaking time.
        </p>

        <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Presentation Mode</h4>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
          Press{' '}
          <kbd className="bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 rounded px-1.5 py-0.5 font-mono text-xs">
            f
          </kbd>{' '}
          to enter presentation mode — a fullscreen view with all controls hidden, ideal for projecting the queue during
          a meeting. Press{' '}
          <kbd className="bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 rounded px-1.5 py-0.5 font-mono text-xs">
            f
          </kbd>{' '}
          again or{' '}
          <kbd className="bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 rounded px-1.5 py-0.5 font-mono text-xs">
            Escape
          </kbd>{' '}
          to exit.
        </p>

        <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Keyboard Shortcuts</h4>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
          Press{' '}
          <kbd className="bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 rounded px-1.5 py-0.5 font-mono text-xs">
            ?
          </kbd>{' '}
          at any time to see all available keyboard shortcuts, including keys for entering the queue and switching tabs.
          Shortcuts can also be disabled from the same dialogue.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/*  For Chairs (conditional)                                           */}
      {/* ------------------------------------------------------------------ */}

      {showChairHelp && (
        <section className="mb-8">
          <h3 className="text-base font-semibold text-stone-800 dark:text-stone-200 mb-3 border-b border-stone-200 dark:border-stone-700 pb-1">
            For Chairs
          </h3>

          <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Creating a Meeting</h4>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
            On the home page, click <strong>Start a New Meeting</strong>. Share the resulting meeting ID or URL with
            participants. You'll be the initial chair. On the <strong>Agenda</strong> tab, you can add or remove other
            chairs (but not yourself).
          </p>

          <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Managing the Agenda</h4>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
            On the <strong>Agenda</strong> tab, click <strong>New Agenda Item</strong> to add items. Each item has a
            name, an owner (the person who will present it), and an optional timebox in minutes. Drag items to reorder
            them. Click <strong>edit</strong> or <strong>delete</strong> to modify or remove items. Agenda item names
            support basic inline markdown (bold, italic, strikethrough, code, and links).
          </p>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
            You can <strong>import an agenda</strong> from a URL to a markdown document (e.g. a TC39 meeting agenda on
            GitHub). The parser extracts items from both numbered lists and markdown tables.
          </p>

          <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Running the Meeting</h4>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
            Switch to the <strong>Queue</strong> tab to run the meeting:
          </p>
          <ol className="text-sm text-stone-600 dark:text-stone-400 ml-4 mb-3 space-y-1 list-decimal">
            <li>
              Click <strong>Start Meeting</strong> to advance to the first agenda item. The item's owner becomes the
              current speaker.
            </li>
            <li>
              As participants enter the queue, click <strong>Next Speaker</strong> to advance through them. The queue
              automatically orders entries by priority.
            </li>
            <li>
              When discussion on an item is complete, click <strong>Next Agenda Item</strong> to move on. If the queue
              is non-empty you'll be asked to confirm. The queue is cleared and the next item's owner becomes the
              speaker. Any remaining queue entries are recorded in the meeting log, so you can restore them later if the
              agenda item is revisited.
            </li>
          </ol>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
            The <strong>Next Speaker</strong> button (and the{' '}
            <kbd className="bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 rounded px-1.5 py-0.5 font-mono text-xs">
              s
            </kbd>{' '}
            keyboard shortcut) is briefly disabled after each use to prevent accidental double-advancement. It is also
            disabled for a longer period when another chair advances the speaker, giving you time to see who is now
            speaking before advancing again.
          </p>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
            You can drag queue entries to reorder them manually. When an entry is moved, its type adjusts to stay
            consistent with the priority ordering of its neighbours. You can also click the type label to cycle through
            legal types, and edit or delete any entry.
          </p>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
            Count-up timers are shown for the current agenda item, current topic, and current speaker. The agenda item
            timer turns bold red when the timebox is exceeded.
          </p>

          <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Copy and Restore Queue</h4>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
            Next to the "Speaker Queue" heading, you'll find <strong>Copy Queue</strong> and{' '}
            <strong>Restore Queue</strong> buttons.
          </p>
          <ul className="text-sm text-stone-600 dark:text-stone-400 ml-4 mb-3 space-y-1 list-disc">
            <li>
              <strong>Copy Queue</strong> copies the queue to your clipboard in a text format (one entry per line,
              including the author's username).
            </li>
            <li>
              <strong>Restore Queue</strong> lets you paste entries in the same format to bulk-add them. Entries that
              include a username in parentheses are added as that user, preserving the original author.
            </li>
          </ul>

          <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Closing the Queue</h4>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">
            Use the <strong>Close Queue</strong> button in the Speaker Queue header to prevent participants from adding
            new entries. When the queue is closed:
          </p>
          <ul className="text-sm text-stone-600 dark:text-stone-400 ml-4 mb-2 space-y-1 list-disc">
            <li>
              Participants' entry type buttons are disabled and keyboard shortcuts for adding entries are blocked.
            </li>
            <li>
              Participants can still raise a <strong>Point of Order</strong> — procedural interruptions are always
              permitted, even when the queue is closed.
            </li>
            <li>
              Chairs can still add entries — both directly and via <strong>Restore Queue</strong>.
            </li>
            <li>Existing entries remain in the queue and can still be edited, reordered, or removed.</li>
          </ul>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
            The queue is closed by default before the meeting starts. It automatically reopens when advancing to a new
            agenda item. Click <strong>Open Queue</strong> to reopen it manually at any time.
          </p>

          <h4 className="font-medium text-stone-700 dark:text-stone-300 mt-4 mb-1">Polls</h4>
          <p className="text-sm text-stone-600 dark:text-stone-400 mb-2">To gauge the room's sentiment on a topic:</p>
          <ol className="text-sm text-stone-600 dark:text-stone-400 ml-4 mb-3 space-y-1 list-decimal">
            <li>
              Click <strong>Create Poll</strong> in the agenda item section.
            </li>
            <li>
              A setup form appears where you can optionally enter a topic for the poll. It includes default response
              options that you can add, remove, or customise (each has an emoji and a label). You can also choose
              whether participants may select multiple options or only one.
            </li>
            <li>
              Click <strong>Start Poll</strong>. All participants see the reaction buttons and can respond.
            </li>
            <li>
              Click <strong>Copy Results</strong> to copy a summary to your clipboard.
            </li>
            <li>
              Click <strong>Stop Poll</strong> when done. The results will be recorded in the meeting log.
            </li>
          </ol>
        </section>
      )}
    </div>
  );
}
