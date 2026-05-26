/**
 * Modal dialog showing all available keyboard shortcuts.
 * Triggered by pressing '?'. Includes a toggle to enable/disable
 * shortcuts, persisted to localStorage.
 *
 * Built on the shared native-<dialog> hook (see useNativeDialog): the platform
 * provides focus trapping, focus restoration, and Esc / light-dismiss. The
 * element is always mounted and rendered by the parent unconditionally; `open`
 * drives showModal()/close().
 */

import type { Shortcut } from '../hooks/useKeyboardShortcuts.js';
import { useNativeDialog, dialogAutoFocus } from '../hooks/useNativeDialog.js';

interface KeyboardShortcutsDialogProps {
  open: boolean;
  shortcuts: Shortcut[];
  enabled: boolean;
  onToggleEnabled: () => void;
  onClose: () => void;
}

/** Group shortcuts by category, preserving insertion order. */
function groupByCategory(shortcuts: Shortcut[]): [string, Shortcut[]][] {
  const groups = new Map<string, Shortcut[]>();
  for (const shortcut of shortcuts) {
    const category = shortcut.category ?? '';
    let group = groups.get(category);
    if (!group) {
      group = [];
      groups.set(category, group);
    }
    group.push(shortcut);
  }
  return [...groups.entries()];
}

export function KeyboardShortcutsDialog({
  open,
  shortcuts,
  enabled,
  onToggleEnabled,
  onClose,
}: KeyboardShortcutsDialogProps) {
  const { dialogRef, renderContents } = useNativeDialog(open, onClose);
  const groups = groupByCategory(shortcuts);

  return (
    <dialog
      ref={dialogRef}
      aria-label="Keyboard shortcuts"
      className="tcq-dialog w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg
                 border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-6 text-left
                 shadow-lg dark:shadow-stone-950/50"
    >
      {renderContents && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-200">Keyboard Shortcuts</h2>
              <button
                onClick={onToggleEnabled}
                className={`text-xs border rounded px-2 py-0.5 cursor-pointer transition-colors ${
                  enabled
                    ? 'border-stone-300 dark:border-stone-600 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
                    : 'border-teal-400 dark:border-teal-600 text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/30'
                }`}
              >
                {enabled ? 'Disable' : 'Enable'}
              </button>
            </div>
            <button
              onClick={onClose}
              // Focus the close button on open rather than letting showModal()
              // land on the first focusable element (the enable/disable toggle).
              ref={dialogAutoFocus}
              className="text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer text-lg"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <table className={`w-full text-sm select-none ${enabled ? '' : 'opacity-40'}`}>
            <tbody>
              {groups.map(([category, groupShortcuts], groupIndex) => (
                <>
                  {category && (
                    <tr key={`heading-${category}`}>
                      <td
                        colSpan={2}
                        className={`text-xs font-medium text-stone-600 dark:text-stone-300 uppercase tracking-wide pb-1 ${groupIndex === 0 ? 'pt-0' : 'pt-4'}`}
                      >
                        {category}
                      </td>
                    </tr>
                  )}
                  {groupShortcuts.map((shortcut) => (
                    <tr key={shortcut.key} className="border-b border-stone-100 dark:border-stone-700 last:border-b-0">
                      <td className="py-1.5 pr-3 pl-3 w-0">
                        <kbd
                          className="inline-block bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                                      font-mono text-xs text-stone-700 dark:text-stone-300 min-w-[1.5rem] text-center"
                        >
                          {shortcut.key === ' ' ? '␣' : shortcut.key}
                        </kbd>
                      </td>
                      <td className="py-1.5 text-stone-600 dark:text-stone-400">{shortcut.description}</td>
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>

          <p className="text-xs text-stone-600 dark:text-stone-300 mt-4">
            {enabled
              ? 'Shortcuts are disabled when typing in a text field.'
              : 'Keyboard shortcuts are currently disabled.'}
          </p>
        </>
      )}
    </dialog>
  );
}
