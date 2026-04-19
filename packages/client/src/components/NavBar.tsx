/**
 * Top navigation bar shown on the meeting page.
 *
 * Layout: "TCQ" branding on the left, Agenda/Queue/Help tab toggles,
 * and the user menu (Log Out or dev user-switcher) on the right.
 */

import { Link } from 'react-router-dom';
import { UserMenu } from './UserMenu.js';
import { Logo } from './Logo.js';

export type Tab = 'agenda' | 'queue' | 'log' | 'help';

interface NavBarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

/** Shared tab button styling. */
function TabButton({
  tab,
  activeTab,
  onTabChange,
  label,
}: {
  tab: Tab;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  label: string;
}) {
  const isActive = activeTab === tab;
  // The outer button provides the full-nav-height click area (py-3). The inner
  // span carries the active-state underline so it stays close to the text.
  return (
    <button
      role="tab"
      aria-selected={isActive}
      aria-controls={`panel-${tab}`}
      className={`group flex items-center py-3 text-base font-medium cursor-pointer transition-colors ${
        isActive
          ? 'text-stone-900 dark:text-stone-100'
          : 'text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300'
      }`}
      onClick={() => onTabChange(tab)}
    >
      <span
        className={`pb-1 border-b-2 transition-colors ${
          isActive
            ? 'border-teal-500'
            : 'border-transparent group-hover:border-stone-300 dark:group-hover:border-stone-600'
        }`}
      >
        {label}
      </span>
    </button>
  );
}

export function NavBar({ activeTab, onTabChange }: NavBarProps) {
  return (
    <nav
      className="scrollbar-hide sticky top-0 z-50 flex items-stretch gap-3 sm:gap-6 border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 sm:px-6 overflow-x-auto"
      aria-label="Main navigation"
    >
      {/* Branding */}
      <Link to="/" className="shrink-0 flex items-center py-3">
        <Logo hideTextOnSmallScreens />
      </Link>

      {/* Tab toggles — active tab has a teal underline */}
      <div className="flex shrink-0 items-stretch gap-4" role="tablist" aria-label="Meeting views">
        <TabButton tab="agenda" activeTab={activeTab} onTabChange={onTabChange} label="Agenda" />
        <TabButton tab="queue" activeTab={activeTab} onTabChange={onTabChange} label="Queue" />
        <TabButton tab="log" activeTab={activeTab} onTabChange={onTabChange} label="Log" />
        <TabButton tab="help" activeTab={activeTab} onTabChange={onTabChange} label="Help" />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* User menu: Log Out in real OAuth, user-switcher in dev mode */}
      <div className="shrink-0 flex items-stretch">
        <UserMenu />
      </div>
    </nav>
  );
}
