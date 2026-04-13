/**
 * Top navigation bar shown on the meeting page.
 *
 * Layout mirrors the original: "TCQ" branding on the left, Agenda/Queue tab
 * toggles, and the user menu (Log Out or dev user-switcher) on the right.
 */

import { UserMenu } from './UserMenu.js';

interface NavBarProps {
  activeTab: 'agenda' | 'queue';
  onTabChange: (tab: 'agenda' | 'queue') => void;
}

export function NavBar({ activeTab, onTabChange }: NavBarProps) {
  return (
    <nav
      className="flex items-center gap-3 sm:gap-6 border-b border-stone-200 bg-white px-3 sm:px-6 py-3"
      aria-label="Main navigation"
    >
      {/* Branding */}
      <span className="text-xl sm:text-2xl font-semibold text-stone-800 select-none">
        TCQ
      </span>

      {/* Tab toggles — active tab has a bold underline for clear indication */}
      <div className="flex gap-4" role="tablist" aria-label="Meeting views">
        <button
          role="tab"
          aria-selected={activeTab === 'agenda'}
          aria-controls="panel-agenda"
          className={`text-base font-medium transition-colors cursor-pointer pb-1 border-b-2 ${
            activeTab === 'agenda'
              ? 'text-stone-900 border-teal-500'
              : 'text-stone-400 border-transparent hover:text-stone-600 hover:border-stone-300'
          }`}
          onClick={() => onTabChange('agenda')}
        >
          Agenda
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'queue'}
          aria-controls="panel-queue"
          className={`text-base font-medium transition-colors cursor-pointer pb-1 border-b-2 ${
            activeTab === 'queue'
              ? 'text-stone-900 border-teal-500'
              : 'text-stone-400 border-transparent hover:text-stone-600 hover:border-stone-300'
          }`}
          onClick={() => onTabChange('queue')}
        >
          Queue
        </button>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* User menu: Log Out in real OAuth, user-switcher in dev mode */}
      <UserMenu />
    </nav>
  );
}
