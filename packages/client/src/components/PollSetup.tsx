/**
 * Poll setup form — shown to chairs when they click "Create Poll", and to
 * everyone else when they click "Request Poll". Allows adding, removing,
 * and editing the response options before starting (or proposing) the
 * poll.
 *
 * In `mode: 'start'` submitting emits `poll:start` and the poll begins
 * immediately. In `mode: 'request'` the identical configuration is sent
 * as `poll:request` instead — it lands in the chairs' pending-requests
 * list and only becomes a poll once a chair approves it. In
 * `mode: 'approve'` the form is pre-filled from a pending request
 * (`initial`) and submitting emits `poll:approveRequest` with the chair's
 * (possibly edited) configuration.
 *
 * Each option has an emoji (entered via text input — users can use
 * their OS emoji picker: Cmd+Ctrl+Space on Mac, Win+. on Windows)
 * and a label. Minimum 2 options required.
 *
 * Defaults to the six standard options from the PRD.
 */

import { useState, useCallback, useLayoutEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { DEFAULT_POLL_OPTIONS } from '@tcq/shared';
import EmojiPicker from '@emoji-mart/react';
import emojiData from '@emoji-mart/data';
import type { PollRequest, User } from '@tcq/shared';
import { useSocket } from '../contexts/SocketContext.js';
import { UserBadge } from './UserBadge.js';
import { RelativeTime } from '../lib/RelativeTime.js';

/** A draft option being configured before the poll starts. */
interface DraftOption {
  /** Temporary client-side key for React rendering. */
  key: number;
  emoji: string;
  label: string;
}

/** Counter for generating unique keys for draft options. */
let nextKey = 0;

/** Rapid repeated submits (double-click, Enter twice) within this window are ignored. */
const SUBMIT_DEBOUNCE_MS = 400;

/** Create the default set of draft options from the shared constants. */
function createDefaults(): DraftOption[] {
  return DEFAULT_POLL_OPTIONS.map((opt) => ({
    key: nextKey++,
    emoji: opt.emoji,
    label: opt.label,
  }));
}

interface EmojiEntry {
  skins: { native: string }[];
}
interface EmojiData {
  emojis: Record<string, EmojiEntry>;
  categories: { id: string; emojis: string[] }[];
}

/** IDs matching this pattern are multi-person family/couple combinations. */
const FAMILY_COMBO_RE =
  /^(?:family|man-|woman-|two_(?:wo)?men_|man_and_woman_|people_holding|couplekiss|couple_with_heart|woman-(?:kiss|heart)-|man-(?:kiss|heart)-)/;

/** Check whether an emoji is acceptable for random selection (no flags, no skin tone modifiers, no family combos). */
function acceptableRandomEmoji(id: string, emoji: EmojiEntry, flagIds: Set<string>): boolean {
  if (flagIds.has(id)) return false;
  if (emoji.skins.length > 1) return false;
  if (FAMILY_COMBO_RE.test(id)) return false;
  return true;
}

/** All acceptable emoji for random selection, derived from the emoji-mart dataset. */
const RANDOM_EMOJI_POOL: string[] = (() => {
  const data = emojiData as EmojiData;
  const flagIds = new Set(data.categories.find((c) => c.id === 'flags')?.emojis ?? []);
  return Object.entries(data.emojis)
    .filter(([id, emoji]) => acceptableRandomEmoji(id, emoji, flagIds))
    .map(([, emoji]) => emoji.skins[0].native);
})();

function randomEmoji(): string {
  return RANDOM_EMOJI_POOL[Math.floor(Math.random() * RANDOM_EMOJI_POOL.length)];
}

/**
 * Single-line-looking text field that wraps and grows with its content
 * instead of scrolling horizontally, so a long poll topic or option label
 * is readable in full — which matters most when a chair is reviewing a
 * participant's request before approving it. Newlines aren't part of a
 * topic/label: Enter submits the surrounding form (like an <input>), and
 * pasted line breaks are collapsed to spaces.
 */
function AutoGrowTextarea({
  value,
  onChange,
  className = '',
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows'> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // jsdom reports 0 — leave the browser default height in that case.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
      onKeyDown={handleKeyDown}
      className={`resize-none overflow-hidden ${className}`}
      {...rest}
    />
  );
}

interface PollSetupProps {
  /**
   * `'start'` (chairs): submit starts the poll. `'request'` (everyone
   * else): submit proposes it for chair approval. `'approve'` (chairs
   * reviewing a pending request): submit starts the poll from the
   * request, edits included. Defaults to `'start'`.
   */
  mode?: 'start' | 'request' | 'approve';
  /**
   * A pending request to pre-fill the form from. Required in `'approve'`
   * mode; in `'request'` mode it lets a requester revise their own
   * pending request (re-submitting replaces it server-side).
   */
  initial?: PollRequest;
  /** The `initial` request's author, shown in the header when known. */
  requester?: User;
  /**
   * The pending request id to approve in `'approve'` mode. Defaults to
   * `initial.id`; the review dialog passes the requester's live request id
   * when `initial` has since been superseded by a revision, so approving
   * runs exactly what the chair sees in the form.
   */
  approveRequestId?: string;
  /**
   * Disable the submit button with an explanation — e.g. while another
   * poll is already running, so a request can't be approved on top of it.
   */
  submitDisabledReason?: string;
  /**
   * Optional destructive secondary action rendered next to Cancel —
   * "Dismiss request" for a reviewing chair, "Withdraw" for the requester.
   */
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean };
  /**
   * Called just before emitting; return `false` to swallow the submit
   * (used by the review dialog's debounce/cooldown guard). The form's
   * own rapid-resubmit debounce applies regardless.
   */
  beforeSubmit?: () => boolean;
  /**
   * A notice shown under the header with a single action — used by the
   * review dialog when the requester revises the request mid-review
   * ("Load revision"). The form contents are left alone until the action
   * is taken.
   */
  notice?: { text: string; actionLabel: string; onAction: () => void };
  onCancel: () => void;
  /** Called after the form has emitted (poll started, request sent, or request approved). */
  onSubmitted: () => void;
}

/** Turn a pending request's options into editable drafts. */
function draftsFrom(request: PollRequest): DraftOption[] {
  return request.options.map((opt) => ({ key: nextKey++, emoji: opt.emoji, label: opt.label }));
}

export function PollSetup({
  mode = 'start',
  initial,
  requester,
  approveRequestId,
  submitDisabledReason,
  secondaryAction,
  beforeSubmit,
  notice,
  onCancel,
  onSubmitted,
}: PollSetupProps) {
  // Ignore a second submit within this window (double-click, Enter twice).
  const lastSubmitRef = useRef(0);
  const isRequest = mode === 'request';
  const isApprove = mode === 'approve';

  const socket = useSocket();
  const [topic, setTopic] = useState(initial?.topic ?? '');
  const [multiSelect, setMultiSelect] = useState(initial?.multiSelect ?? true);
  const [options, setOptions] = useState<DraftOption[]>(() => (initial ? draftsFrom(initial) : createDefaults()));

  /** Key of the option whose emoji picker is open, or null if none. */
  const [pickerOpenFor, setPickerOpenFor] = useState<number | null>(null);
  /** Position for the emoji picker popover (fixed positioning). */
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null);

  /** Open the picker positioned relative to the clicked button. */
  const openPicker = useCallback(
    (key: number, button: HTMLButtonElement) => {
      if (pickerOpenFor === key) {
        setPickerOpenFor(null);
        return;
      }
      const rect = button.getBoundingClientRect();
      const pickerHeight = 435; // emoji-mart default height
      const margin = 8;
      // Open to the right of the button, aligned to its top, shifted up if needed to fit
      const top = Math.min(rect.top, window.innerHeight - pickerHeight - margin);
      const left = rect.right + 4;
      setPickerPos({ top, left });
      setPickerOpenFor(key);
    },
    [pickerOpenFor],
  );

  /** Update a single option's field. */
  function updateOption(key: number, field: 'emoji' | 'label', value: string) {
    setOptions((prev) => prev.map((opt) => (opt.key === key ? { ...opt, [field]: value } : opt)));
  }

  /** Remove an option by its key. */
  function removeOption(key: number) {
    setOptions((prev) => prev.filter((opt) => opt.key !== key));
  }

  /** Add a new option with a random emoji at the end. */
  function addOption() {
    setOptions((prev) => [...prev, { key: nextKey++, emoji: randomEmoji(), label: '' }]);
  }

  /** Start (or request) the poll with the configured options. */
  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // Filter to valid options (non-empty emoji and label)
    const validOptions = options.filter((opt) => opt.emoji.trim() && opt.label.trim());

    if (validOptions.length < 2) return;

    const now = Date.now();
    if (now - lastSubmitRef.current < SUBMIT_DEBOUNCE_MS) return;
    if (beforeSubmit && !beforeSubmit()) return;
    lastSubmitRef.current = now;

    const payload = {
      topic: topic.trim() || undefined,
      multiSelect,
      options: validOptions.map((opt) => ({
        emoji: opt.emoji.trim(),
        label: opt.label.trim(),
      })),
    };
    // Same payload shape in every mode — a request is a poll that hasn't
    // been approved yet, and approving sends the reviewed configuration
    // back so any chair edits are what actually runs.
    if (isApprove && initial) {
      socket?.emit('poll:approveRequest', { id: approveRequestId ?? initial.id, ...payload });
    } else if (isRequest) {
      socket?.emit('poll:request', payload);
    } else {
      socket?.emit('poll:start', payload);
    }

    onSubmitted();
  }

  const heading = isApprove
    ? 'Review Poll Request'
    : isRequest
      ? initial
        ? 'Edit Poll Request'
        : 'Request Poll'
      : 'Create Poll';
  const submitLabel = isApprove
    ? 'Approve & Start Poll'
    : isRequest
      ? initial
        ? 'Update Request'
        : 'Request Poll'
      : 'Start Poll';

  // Count valid options for the minimum-2 check
  const validCount = options.filter((opt) => opt.emoji.trim() && opt.label.trim()).length;

  return (
    <form onSubmit={handleSubmit} className="p-6">
      {/* Header: title + close (✕). Cancel lives here, not in the footer,
          so the footer's rightmost button is always the "continue" action. */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <h3 className="text-lg font-semibold text-stone-800 dark:text-stone-200">{heading}</h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100 cursor-pointer text-lg leading-none -mr-1 -mt-0.5"
        >
          ✕
        </button>
      </div>
      {notice && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 rounded border border-amber-300 dark:border-amber-700
                     bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
        >
          <span className="flex-1">{notice.text}</span>
          <button
            type="button"
            onClick={notice.onAction}
            className="text-sm font-medium border border-amber-400 dark:border-amber-600 rounded px-2 py-0.5
                       hover:bg-amber-100 dark:hover:bg-amber-800/50 transition-colors cursor-pointer"
          >
            {notice.actionLabel}
          </button>
        </div>
      )}
      {initial && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-600 dark:text-stone-400 mb-3">
          Requested by
          <UserBadge user={requester} size={18} className="text-stone-800 dark:text-stone-200" />
          <RelativeTime timestamp={initial.requestedAt} className="text-xs text-stone-500 dark:text-stone-400" />
        </p>
      )}

      {/* Poll topic (optional) */}
      <AutoGrowTextarea
        value={topic}
        onChange={setTopic}
        placeholder="Poll topic (optional)"
        aria-label="Poll topic"
        className="block w-full border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm mb-3
                   dark:bg-stone-700 dark:text-stone-100
                   focus:outline-none focus:ring-1 focus:ring-teal-500"
      />

      {/* Selection mode */}
      <label className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400 mb-3 cursor-pointer select-none">
        <input type="checkbox" checked={multiSelect} onChange={(e) => setMultiSelect(e.target.checked)} />
        Allow selecting multiple options
      </label>

      {/* Option list */}
      <div className="space-y-2 mb-3">
        {options.map((opt) => (
          <div key={opt.key} className="flex items-start gap-2 relative">
            {/* Emoji picker button */}
            <button
              type="button"
              onClick={(e) => openPicker(opt.key, e.currentTarget)}
              aria-label="Choose emoji"
              className="border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-center text-lg w-12
                         dark:bg-stone-700 dark:text-stone-100 cursor-pointer
                         hover:bg-stone-50 dark:hover:bg-stone-600 transition-colors"
            >
              {opt.emoji || '😀'}
            </button>
            {pickerOpenFor === opt.key && pickerPos && (
              <>
                {/* Invisible backdrop to dismiss picker on outside click */}
                <div className="fixed inset-0 z-40" onClick={() => setPickerOpenFor(null)} />
                <div
                  className="fixed z-50"
                  style={{ top: pickerPos.top, left: pickerPos.left }}
                  ref={(el) => {
                    if (!el) return;
                    // emoji-mart renders a shadow DOM; find and focus the search input
                    requestAnimationFrame(() => {
                      const shadow = el.querySelector('em-emoji-picker')?.shadowRoot;
                      const input = shadow?.querySelector('input[type="search"]') as HTMLInputElement | null;
                      input?.focus();
                    });
                  }}
                >
                  <EmojiPicker
                    data={emojiData}
                    onEmojiSelect={(emoji: { native: string }) => {
                      updateOption(opt.key, 'emoji', emoji.native);
                      setPickerOpenFor(null);
                    }}
                    theme="auto"
                    previewPosition="none"
                  />
                </div>
              </>
            )}

            {/* Label input */}
            <AutoGrowTextarea
              value={opt.label}
              onChange={(value) => updateOption(opt.key, 'label', value)}
              placeholder="Label"
              aria-label="Option label"
              className="border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm flex-1 min-w-0
                         dark:bg-stone-700 dark:text-stone-100
                         focus:outline-none focus:ring-1 focus:ring-teal-500"
            />

            {/* Remove button — disabled if we'd go below 2 */}
            <button
              type="button"
              onClick={() => removeOption(opt.key)}
              disabled={options.length <= 2}
              className="text-xs text-stone-600 dark:text-stone-300 enabled:hover:text-red-600 dark:enabled:hover:text-red-400 transition-colors
                         cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Remove option"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Add option button */}
      <button
        type="button"
        onClick={addOption}
        className="text-sm text-blue-600 hover:text-blue-800 transition-colors cursor-pointer mb-3"
      >
        + Add Option
      </button>

      {/* Footer: destructive secondary action (if any) on the left, the
          primary "continue" action furthest right. Any disabled-reason
          note sits between them. */}
      <div className="flex items-center gap-3 border-t border-stone-100 dark:border-stone-700 pt-3">
        {secondaryAction && (
          <button
            type="button"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
            className="text-sm text-stone-600 dark:text-stone-300 enabled:hover:text-red-600 dark:enabled:hover:text-red-400 transition-colors cursor-pointer
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {secondaryAction.label}
          </button>
        )}
        {submitDisabledReason && (
          <p className="ml-auto text-xs text-right text-stone-500 dark:text-stone-400">{submitDisabledReason}</p>
        )}
        <button
          type="submit"
          disabled={validCount < 2 || submitDisabledReason !== undefined}
          title={submitDisabledReason}
          className={`${submitDisabledReason ? '' : 'ml-auto '}bg-teal-700 text-white px-4 py-1.5 rounded text-sm font-medium
                     enabled:hover:bg-teal-800 transition-colors cursor-pointer
                     disabled:opacity-50 disabled:cursor-not-allowed
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900`}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
