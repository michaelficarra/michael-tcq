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
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={onClose}
      role="dialog"
      aria-label="Keyboard shortcuts"
      aria-modal="true"
    >
      {/* Dialog box */}
      <div
        className="bg-white rounded-lg shadow-lg border border-stone-200 p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-stone-800">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 cursor-pointer text-lg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <table className={`w-full text-sm select-none ${enabled ? '' : 'opacity-40'}`}>
          <tbody>
            {shortcuts.map((shortcut) => (
              <tr key={shortcut.key} className="border-b border-stone-100 last:border-b-0">
                <td className="py-1.5 pr-4">
                  <kbd className="inline-block bg-stone-100 border border-stone-300 rounded px-2 py-0.5
                                  font-mono text-xs text-stone-700 min-w-[1.5rem] text-center">
                    {shortcut.key === ' ' ? '␣' : shortcut.key}
                  </kbd>
                </td>
                <td className="py-1.5 text-stone-600">
                  {shortcut.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-stone-400">
            {enabled
              ? 'Shortcuts are disabled when typing in a text field.'
              : 'Keyboard shortcuts are currently disabled.'}
          </p>

          {/* Toggle button */}
          <button
            onClick={onToggleEnabled}
            className={`text-xs border rounded px-2 py-0.5 cursor-pointer transition-colors ${
              enabled
                ? 'border-stone-300 text-stone-600 hover:bg-stone-100'
                : 'border-teal-400 text-teal-600 hover:bg-teal-50'
            }`}
          >
            {enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>
    </div>
  );
}
