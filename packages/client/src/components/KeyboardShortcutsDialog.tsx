/**
 * Modal dialog showing all available keyboard shortcuts.
 * Triggered by pressing '?'. Includes a toggle to enable/disable
 * shortcuts, persisted to localStorage.
 */

import type { Shortcut } from '../hooks/useKeyboardShortcuts.js';

interface KeyboardShortcutsDialogProps {
  shortcuts: Shortcut[];
  enabled: boolean;
  onToggleEnabled: () => void;
  onClose: () => void;
}

export function KeyboardShortcutsDialog({
  shortcuts, enabled, onToggleEnabled, onClose,
}: KeyboardShortcutsDialogProps) {
  return (
    // Backdrop
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-40"
      onClick={onClose}
      role="dialog"
      aria-label="Keyboard shortcuts"
      aria-modal="true"
    >
      {/* Dialog box */}
      <div
        className="bg-white dark:bg-stone-900 rounded-lg shadow-lg dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-200">
              Keyboard Shortcuts
            </h2>
            <button
              onClick={onToggleEnabled}
              className={`text-xs border rounded px-2 py-0.5 cursor-pointer transition-colors ${
                enabled
                  ? 'border-stone-300 dark:border-stone-600 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
                  : 'border-teal-400 dark:border-teal-600 text-teal-600 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/30'
              }`}
            >
              {enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer text-lg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <table className={`w-full text-sm select-none ${enabled ? '' : 'opacity-40'}`}>
          <tbody>
            {shortcuts.map((shortcut) => (
              <tr key={shortcut.key} className="border-b border-stone-100 dark:border-stone-700 last:border-b-0">
                <td className="py-1.5 pr-4">
                  <kbd className="inline-block bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                                  font-mono text-xs text-stone-700 dark:text-stone-300 min-w-[1.5rem] text-center">
                    {shortcut.key === ' ' ? '␣' : shortcut.key}
                  </kbd>
                </td>
                <td className="py-1.5 text-stone-600 dark:text-stone-400">
                  {shortcut.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="text-xs text-stone-400 dark:text-stone-500 mt-4">
          {enabled
            ? 'Shortcuts are disabled when typing in a text field.'
            : 'Keyboard shortcuts are currently disabled.'}
        </p>
      </div>
    </div>
  );
}
