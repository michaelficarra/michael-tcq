/**
 * GitHub-username combobox: a text input backed by an autocomplete
 * dropdown of fuzzy matches from the server's directory.
 *
 * Two modes:
 *   - `mode="single"` — emits one username on selection (clear on blur).
 *     Used for the chair-add input and the dev user-switcher.
 *   - `mode="multi"` — chip/tag input. Each commit (Enter, comma, blur)
 *     turns the typed/selected value into a token; existing tokens are
 *     editable as a chip row.
 *
 * The dropdown is a *suggestion* layer, not a constraint: pressing Enter
 * or comma on a value that doesn't match any suggestion still commits the
 * raw text. This matters because some presenters don't have a GitHub
 * account and the input has historically allowed arbitrary names.
 *
 * Network behaviour: queries the server only after 250ms of typing
 * inactivity. This protects both our endpoint and the upstream GitHub
 * search-API budget (30 req/min/user). The latest in-flight result wins;
 * stale responses are dropped via a request id so a slow earlier query
 * cannot overwrite a faster later one.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { normaliseGithubUsername } from '@tcq/shared';
import { FALLBACK_AVATAR } from './UserBadge.js';

interface DirectoryUser {
  ghid: number;
  login: string;
  name: string;
  /** GitHub `company` field if known. Empty string when unknown. */
  organisation: string;
  avatarUrl: string;
  badge?: 'meeting' | 'org';
}

interface AutocompleteResponse {
  users: DirectoryUser[];
}

const DEBOUNCE_MS = 250;
const DROPDOWN_LIMIT = 10;

// Reuse one AbortController per consumer of fetchSuggestions — see hook.
type SuggestionsState = {
  loading: boolean;
  results: DirectoryUser[];
};

function useSuggestions(meetingId: string | undefined) {
  const [state, setState] = useState<SuggestionsState>({ loading: false, results: [] });
  // requestId guards against out-of-order responses: a slow earlier request
  // resolving after a fast later one would otherwise stomp the latest results.
  const requestIdRef = useRef(0);

  const fetchFor = useCallback(
    (query: string) => {
      // Skip the network entirely on an empty query — the dropdown shouldn't
      // appear until the user types at least one character. Bumping the
      // request id also invalidates any in-flight earlier query so its late
      // response can't repopulate the dropdown.
      if (query.trim().length === 0) {
        requestIdRef.current++;
        setState({ loading: false, results: [] });
        return;
      }
      const myId = ++requestIdRef.current;
      setState((s) => ({ ...s, loading: true }));
      const params = new URLSearchParams({ q: query, limit: String(DROPDOWN_LIMIT) });
      if (meetingId) params.set('meetingId', meetingId);
      fetch(`/api/users/autocomplete?${params}`)
        .then((res) => (res.ok ? (res.json() as Promise<AutocompleteResponse>) : { users: [] }))
        .catch(() => ({ users: [] as DirectoryUser[] }))
        .then((body) => {
          // Drop stale responses — only the most recently fired request wins.
          if (myId !== requestIdRef.current) return;
          setState({ loading: false, results: body.users });
        });
    },
    [meetingId],
  );

  const reset = useCallback(() => {
    requestIdRef.current++;
    setState({ loading: false, results: [] });
  }, []);

  return { ...state, fetchFor, reset };
}

interface CommonProps {
  /** Optional meeting context — biases tier-1 suggestions to this meeting's users. */
  meetingId?: string;
  /** Placeholder text for the input. */
  placeholder?: string;
  /** Extra classes for the input element. */
  inputClassName?: string;
  /** ARIA label for the input. */
  ariaLabel?: string;
  /** Whether to autofocus the input on mount. */
  autoFocus?: boolean;
  /** Disables the input. */
  disabled?: boolean;
}

interface SingleProps extends CommonProps {
  mode: 'single';
  /** Initial input value. */
  initialValue?: string;
  /**
   * Called when the user commits a value: presses Enter on the input or
   * selects a suggestion. Receives the normalised username (raw text or
   * suggestion login).
   */
  onCommit: (username: string) => void;
  /** Called when the user presses Escape on the input. */
  onCancel?: () => void;
}

interface MultiProps extends CommonProps {
  mode: 'multi';
  /** Current list of tokens. Controlled by the parent. */
  values: string[];
  /** Called when tokens change (added or removed). */
  onChange: (next: string[]) => void;
}

export type UserComboboxProps = SingleProps | MultiProps;

export function UserCombobox(props: UserComboboxProps) {
  if (props.mode === 'multi') return <MultiCombobox {...props} />;
  return <SingleCombobox {...props} />;
}

// -- Single-select variant -----------------------------------------------

function SingleCombobox(props: SingleProps) {
  const {
    meetingId,
    placeholder,
    inputClassName,
    ariaLabel,
    autoFocus,
    disabled,
    initialValue = '',
    onCommit,
    onCancel,
  } = props;

  const [value, setValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  // Pre-filled inputs (e.g. the dev user-switcher prefilled with the current
  // username) shouldn't fetch suggestions or open the dropdown until the
  // user has actually edited the value. Flips to `true` on the first
  // change event and stays there for the rest of this control's lifetime.
  const [hasUserEdited, setHasUserEdited] = useState(false);
  // -1 means "nothing highlighted" — Enter then commits the typed text
  // verbatim. The user has to press ArrowDown to bring focus into the
  // dropdown and start picking suggestions.
  const [highlighted, setHighlighted] = useState(-1);
  const suggestions = useSuggestions(meetingId);
  const listboxId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Anchor ref for the portaled dropdown — needs to be a regular RefObject
  // so the SuggestionList effect can re-measure on scroll/resize.
  const anchorRef = useRef<HTMLInputElement>(null);
  // Callback ref: when autoFocus is set, also select the existing text so
  // the user can immediately overwrite it (matches the dev-switcher UX
  // before this control existed). Also forwards to anchorRef so the
  // dropdown can position itself.
  const inputRef = useCallback(
    (node: HTMLInputElement | null) => {
      anchorRef.current = node;
      if (node && autoFocus && initialValue) {
        node.select();
      }
    },
    [autoFocus, initialValue],
  );

  // Schedule a fetch on every value change after the debounce window.
  // Skipped entirely until the user has edited the input — pre-filled
  // values (e.g. the dev switcher's current username) don't burn a
  // request just because the control mounted.
  useEffect(() => {
    if (!hasUserEdited) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      suggestions.fetchFor(value);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // suggestions.fetchFor is referentially stable per meetingId; including
    // it would re-schedule on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, meetingId, hasUserEdited]);

  function commit(raw: string) {
    const cleaned = normaliseGithubUsername(raw);
    if (!cleaned) return;
    onCommit(cleaned);
    setValue('');
    suggestions.reset();
    setOpen(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      // -1 → first ArrowDown moves to index 0 ("first entry"). Subsequent
      // presses advance and stop at the last entry.
      setHighlighted((h) => Math.min(h + 1, suggestions.results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // Bottom-stop at -1 ("back to typed text"), so ArrowUp past the
      // first suggestion releases focus from the dropdown without
      // wrapping to the end.
      setHighlighted((h) => Math.max(h - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Only commit a suggestion if the user has explicitly highlighted
      // one (highlighted >= 0). Otherwise commit whatever they've typed —
      // this is the free-text fallback for users without GitHub accounts.
      if (open && highlighted >= 0 && suggestions.results[highlighted]) {
        commit(suggestions.results[highlighted].login);
      } else {
        commit(value);
      }
    } else if (e.key === 'Escape') {
      // Close the suggestion dropdown and bubble cancel to the parent in one
      // press — matches the "Escape dismisses" pattern across the app.
      setOpen(false);
      onCancel?.();
    }
  }

  function handleBlur(_e: FocusEvent<HTMLInputElement>) {
    // Delay closing so a click on a dropdown item registers before the
    // dropdown unmounts.
    setTimeout(() => setOpen(false), 120);
  }

  return (
    <div className="relative inline-block">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          // First user-driven edit unlocks suggestions; subsequent edits
          // leave the flag set so re-clearing the field doesn't suppress
          // them again.
          setHasUserEdited(true);
          // Reset to "nothing highlighted" — typing should never silently
          // change which suggestion an Enter would commit.
          setHighlighted(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-activedescendant={
          open && highlighted >= 0 && suggestions.results[highlighted] ? `${listboxId}-${highlighted}` : undefined
        }
        role="combobox"
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
        className={inputClassName}
      />
      {open && hasUserEdited && value.trim().length > 0 && suggestions.results.length > 0 && (
        <SuggestionList
          id={listboxId}
          results={suggestions.results}
          highlighted={highlighted}
          onPick={(user) => commit(user.login)}
          onHover={setHighlighted}
          anchorRef={anchorRef}
        />
      )}
    </div>
  );
}

// -- Multi-select (chip) variant ----------------------------------------

function MultiCombobox(props: MultiProps) {
  const { meetingId, placeholder, inputClassName, ariaLabel, autoFocus, disabled, values, onChange } = props;

  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  // -1 means "nothing highlighted" — Enter or comma then commits the
  // typed text verbatim. ArrowDown brings focus into the dropdown.
  const [highlighted, setHighlighted] = useState(-1);
  const suggestions = useSuggestions(meetingId);
  const listboxId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Anchor ref for the portaled dropdown — points at the chip wrapper so
  // the dropdown lines up with the full chip row, not just the inner input.
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      suggestions.fetchFor(draft);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, meetingId]);

  // Filter the dropdown so already-tokenised users don't appear.
  const filteredResults = useMemo(() => {
    const taken = new Set(values.map((v) => v.toLowerCase()));
    return suggestions.results.filter((u) => !taken.has(u.login.toLowerCase()));
  }, [suggestions.results, values]);

  function commit(raw: string) {
    const cleaned = normaliseGithubUsername(raw);
    if (!cleaned) return;
    if (values.some((v) => v.toLowerCase() === cleaned.toLowerCase())) {
      // Already in the list — clear the draft but don't add a duplicate.
      setDraft('');
      return;
    }
    onChange([...values, cleaned]);
    setDraft('');
    suggestions.reset();
    setHighlighted(-1);
  }

  function removeAt(index: number) {
    const next = values.slice();
    next.splice(index, 1);
    onChange(next);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min(h + 1, filteredResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, -1));
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      // Only commit a suggestion if explicitly highlighted. Otherwise
      // commit the typed draft (free-text fallback).
      if (open && highlighted >= 0 && filteredResults[highlighted]) {
        commit(filteredResults[highlighted].login);
      } else {
        commit(draft);
      }
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      // Delete the last token when backspacing into an empty input.
      removeAt(values.length - 1);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <div
        ref={anchorRef}
        className={`flex flex-wrap items-center gap-1 border border-stone-300 dark:border-stone-600 rounded
                    px-2 py-1 dark:bg-stone-700 focus-within:ring-2 focus-within:ring-teal-500 focus-within:border-teal-500`}
      >
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            // Pill background needs to contrast with the chip-input wrapper
            // (`dark:bg-stone-700`) — stone-600 is only one step apart and
            // disappears against it. stone-500 + stone-100 text gives a
            // clear, accessible contrast in dark mode while staying within
            // the stone palette used elsewhere in the app.
            className="inline-flex items-center gap-1 bg-stone-200 dark:bg-stone-500 rounded-full pl-0.5 pr-1 py-0.5 text-xs text-stone-700 dark:text-stone-100"
          >
            {/*
              GitHub serves a public avatar at github.com/{login}.png for any
              valid login. Free-text entries that aren't real GitHub users
              degrade to the same generic silhouette UserBadge falls back to.
            */}
            <img
              src={`https://github.com/${v}.png?size=32`}
              alt=""
              width={16}
              height={16}
              style={{ width: 16, height: 16, minWidth: 16, minHeight: 16 }}
              className="rounded-full shrink-0"
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                if (!img.src.startsWith('data:')) img.src = FALLBACK_AVATAR;
              }}
            />
            <span>{v}</span>
            <button
              type="button"
              onClick={() => removeAt(i)}
              aria-label={`Remove ${v}`}
              // Match the chair pill remove button so the affordance reads
              // identically across the agenda chair list and the presenter
              // chip input.
              className="text-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            setHighlighted(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // On blur, just dismiss the dropdown — never auto-commit. The
            // typed draft stays put for the user to commit explicitly with
            // Enter, comma, or by clicking a suggestion. The delay lets a
            // mousedown on a suggestion register before the dropdown
            // unmounts.
            setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={handleKeyDown}
          placeholder={values.length === 0 ? placeholder : ''}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={
            open && highlighted >= 0 && filteredResults[highlighted] ? `${listboxId}-${highlighted}` : undefined
          }
          role="combobox"
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete="off"
          className={`flex-1 min-w-[6rem] bg-transparent outline-none text-sm dark:text-stone-100 ${inputClassName ?? ''}`}
        />
      </div>
      {open && draft.trim().length > 0 && filteredResults.length > 0 && (
        <SuggestionList
          id={listboxId}
          results={filteredResults}
          highlighted={highlighted}
          onPick={(user) => commit(user.login)}
          onHover={setHighlighted}
          anchorRef={anchorRef}
        />
      )}
    </div>
  );
}

// -- Shared dropdown ---------------------------------------------------

interface SuggestionListProps {
  id: string;
  results: DirectoryUser[];
  highlighted: number;
  onPick: (user: DirectoryUser) => void;
  onHover: (index: number) => void;
  /**
   * The element the dropdown should anchor beneath. Used to compute fixed
   * coordinates so the dropdown can escape ancestor `overflow:hidden` /
   * `overflow:auto` clipping and stacking-context z-index caps (the navbar
   * is `sticky z-50` with `overflow-x-auto`, both of which clip a plain
   * absolutely-positioned descendant).
   */
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** Margin between the dropdown and the viewport edge when clamped. */
const VIEWPORT_MARGIN = 8;
/** Vertical gap between the anchor and the dropdown. */
const ANCHOR_GAP = 4;
/** Minimum width of the dropdown (matches the previous `min-w-[14rem]`). */
const MIN_WIDTH = 224;
/** Cap on the dropdown's height — also the max-h tailwind class on the ul. */
const MAX_HEIGHT = 288;

function SuggestionList({ id, results, highlighted, onPick, onHover, anchorRef }: SuggestionListProps) {
  // Two-phase positioning. The first measure (in the effect, before the ul
  // exists) places the dropdown using a MAX_HEIGHT estimate. Once the ul
  // mounts a ResizeObserver re-runs the measurement with the ul's real
  // height — this is critical for the "flip above" placement, where using
  // the estimate would otherwise leave a gap equal to the difference
  // between the estimate and the real height. Position is clamped to the
  // viewport so the dropdown never extends past the right/bottom edges;
  // when neither side has room for full height, max-height is capped and
  // the ul scrolls internally. Same shape as the emoji picker in
  // PollSetup.tsx.
  const listElementRef = useRef<HTMLUListElement | null>(null);
  const measureRef = useRef<() => void>(() => {});
  const observerRef = useRef<ResizeObserver | null>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    minWidth: number;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    function measure() {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      if (!anchorRect) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // The ul uses `width: max-content` so it sizes to its widest row
      // automatically (display name + company + badge can run long when
      // every field is populated). Clamp the natural size with a floor
      // (anchor width / MIN_WIDTH) so the dropdown never looks narrower
      // than the input it's attached to, and a ceiling (viewport minus
      // edge margins) so it never overflows the screen.
      const minWidth = Math.max(anchorRect.width, MIN_WIDTH);
      const maxWidth = Math.max(MIN_WIDTH, vw - 2 * VIEWPORT_MARGIN);

      // For positioning, use the *rendered* width — the browser has
      // already resolved `max-content` against the min/max bounds, so
      // the bounding rect tells us the real width to clamp `left`
      // against. Falls back to minWidth on the very first pass before
      // the ul mounts; the ResizeObserver re-runs measure with the real
      // width as soon as the ul attaches, correcting any initial
      // estimate.
      const renderedWidth = listElementRef.current?.getBoundingClientRect().width ?? minWidth;

      // Horizontal: prefer left-aligned with the anchor; if the rendered
      // dropdown would overflow the right edge, shift left so the right
      // edge lands on `vw - VIEWPORT_MARGIN`. Then clamp `left >=
      // VIEWPORT_MARGIN` so it never disappears off the left.
      let left = anchorRect.left;
      if (left + renderedWidth > vw - VIEWPORT_MARGIN) left = vw - VIEWPORT_MARGIN - renderedWidth;
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

      // Vertical: measure the ul's actual height if it has rendered.
      // Fall back to MAX_HEIGHT only on the very first pass before the
      // ul exists; the observer corrects this in the next layout tick.
      const measuredHeight = listElementRef.current?.getBoundingClientRect().height ?? MAX_HEIGHT;
      const desiredHeight = Math.min(measuredHeight, MAX_HEIGHT);

      const spaceBelow = vh - anchorRect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
      const spaceAbove = anchorRect.top - ANCHOR_GAP - VIEWPORT_MARGIN;

      let top: number;
      let maxHeight: number;
      if (desiredHeight <= spaceBelow) {
        // Fits below — preferred placement.
        top = anchorRect.bottom + ANCHOR_GAP;
        maxHeight = spaceBelow;
      } else if (desiredHeight <= spaceAbove) {
        // Doesn't fit below; flip above. The top is anchored to the input
        // and offset upward by the dropdown's *real* height — this is why
        // the ResizeObserver matters: a stale estimate here leaves a gap
        // equal to (estimate − real).
        top = anchorRect.top - ANCHOR_GAP - desiredHeight;
        maxHeight = spaceAbove;
      } else {
        // Doesn't fit either side at full height — go with whichever has
        // more room and let the ul's internal scroll handle the rest.
        if (spaceBelow >= spaceAbove) {
          top = anchorRect.bottom + ANCHOR_GAP;
          maxHeight = Math.max(spaceBelow, 0);
        } else {
          maxHeight = Math.max(spaceAbove, 0);
          top = anchorRect.top - ANCHOR_GAP - maxHeight;
        }
      }

      setPos((prev) => {
        // Avoid pointless state updates that would re-trigger the effect on
        // every scroll tick when nothing actually moved.
        if (
          prev &&
          prev.top === top &&
          prev.left === left &&
          prev.minWidth === minWidth &&
          prev.maxWidth === maxWidth &&
          prev.maxHeight === maxHeight
        ) {
          return prev;
        }
        return { top, left, minWidth, maxWidth, maxHeight };
      });
    }
    measureRef.current = measure;
    measure();
    // `true` so we catch scrolls inside any ancestor scroll container, not
    // just window scrolls — the navbar lives above the agenda tabpanel
    // which has its own scroll context on small viewports.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
    // `results.length` participates so a change in row count re-runs the
    // measurement directly (in addition to the ResizeObserver below).
  }, [anchorRef, results.length]);

  // Callback ref on the ul: attach a ResizeObserver as soon as the ul
  // mounts so the *real* size triggers a re-measurement. Without this,
  // the first measure() (which runs before the ul exists) uses MAX_HEIGHT
  // as a placeholder and the dropdown sits ~MAX_HEIGHT above the input
  // when flipped, regardless of the actual ul height. The observer fires
  // synchronously on `observe()`, so the corrected position lands in the
  // very next paint.
  const setListNode = useCallback((node: HTMLUListElement | null) => {
    listElementRef.current = node;
    observerRef.current?.disconnect();
    observerRef.current = null;
    // ResizeObserver is unavailable in jsdom and very old browsers; the
    // measurement still re-runs whenever results.length changes (which
    // covers the common "more results just arrived" path), so falling
    // back to no observer is graceful.
    if (node && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        // Always read from the ref so observer callbacks fired after a
        // dependency change still call the latest measure closure.
        measureRef.current();
      });
      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);

  // Clean up the observer on unmount (the callback ref above only fires
  // on attach/detach of the dom node, which on unmount happens after this
  // effect's cleanup runs — so we need an explicit teardown here too).
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  if (!pos) return null;

  return createPortal(
    <ul
      id={id}
      ref={setListNode}
      role="listbox"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        // `max-content` lets the ul size itself to the widest row, with
        // `min-width` keeping it at least as wide as the input it's
        // attached to and `max-width` capping it at the viewport so it
        // never overflows the screen. When even the natural width
        // exceeds the cap, individual rows truncate via the per-span
        // `truncate` class.
        width: 'max-content',
        minWidth: pos.minWidth,
        maxWidth: pos.maxWidth,
        maxHeight: pos.maxHeight,
      }}
      className="z-[80] overflow-auto
                 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-xl shadow-lg py-1"
    >
      {results.map((user, i) => (
        <li
          key={user.ghid}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === highlighted}
          // mousedown rather than click so the input's onBlur (which
          // closes the dropdown) doesn't fire first and remove this <li>
          // from the DOM before its click handler runs. Restricted to the
          // primary button so right-clicks (context menu) and middle-clicks
          // never commit a suggestion.
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            onPick(user);
          }}
          onMouseEnter={() => onHover(i)}
          // Same orange palette as the current-agenda-item highlight in
          // AgendaPanel so the "selected" affordance is consistent across
          // the app, including the dimmed dark-mode variant. Text colour
          // matches the standard dark-mode body pairing so rows don't
          // inherit the browser default and lose contrast against the
          // dark dropdown background.
          className={`flex items-center gap-2 px-2 py-1 cursor-pointer text-sm text-stone-700 dark:text-stone-300 ${
            i === highlighted ? 'bg-orange-100 dark:bg-orange-900/50' : ''
          }`}
        >
          <img
            src={user.avatarUrl}
            alt=""
            width={20}
            height={20}
            style={{ width: 20, height: 20, minWidth: 20, minHeight: 20 }}
            className="rounded-full shrink-0"
          />
          <span>{user.login}</span>
          {user.name && user.name !== user.login && (
            <span className="text-stone-500 dark:text-stone-400">{user.name}</span>
          )}
          {user.organisation && (
            // Organisation gets a fixed max-width and ellipsis so a long
            // company string doesn't blow out the dropdown's natural
            // width. Login and display name stay un-truncated — they're
            // the load-bearing identifiers for matching the right user.
            // The parens stay outside the truncation so the closing `)`
            // is always visible.
            <span className="text-stone-600 dark:text-stone-300 text-xs" title={user.organisation}>
              (<span className="inline-block max-w-[12rem] truncate align-bottom">{user.organisation}</span>)
            </span>
          )}
          {user.badge && (
            <span
              className={`ml-auto text-[10px] uppercase tracking-wide px-1 py-0.5 rounded shrink-0 ${
                user.badge === 'meeting'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  : 'bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-300'
              }`}
            >
              {user.badge === 'meeting' ? 'in meeting' : 'org'}
            </span>
          )}
        </li>
      ))}
    </ul>,
    document.body,
  );
}
