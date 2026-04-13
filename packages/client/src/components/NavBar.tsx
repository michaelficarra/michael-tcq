/**
 * Top navigation bar shown on the meeting page.
 *
 * Layout: "TCQ" branding on the left, Agenda/Queue/Help tab toggles,
 * and the user menu (Log Out or dev user-switcher) on the right.
 */

import { Link } from 'react-router-dom';
import { UserMenu } from './UserMenu.js';
import { Logo } from './Logo.js';

export type Tab = 'agenda' | 'queue' | 'help';

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
  return (
    <button
      role="tab"
      aria-selected={isActive}
      aria-controls={`panel-${tab}`}
      className={`text-base font-medium transition-colors cursor-pointer pb-1 border-b-2 ${
        isActive
          ? 'text-stone-900 border-teal-500'
          : 'text-stone-400 border-transparent hover:text-stone-600 hover:border-stone-300'
      }`}
      onClick={() => onTabChange(tab)}
    >
      {label}
    </button>
  );
}

export function NavBar({ activeTab, onTabChange }: NavBarProps) {
  return (
    <nav
      className="sticky top-0 z-40 flex items-center gap-3 sm:gap-6 border-b border-stone-200 bg-white px-3 sm:px-6 py-3"
      aria-label="Main navigation"
    >
      {/* Branding */}
      <Link to="/">
        <Logo />
      </Link>

      {/* Tab toggles — active tab has a teal underline */}
      <div className="flex gap-4" role="tablist" aria-label="Meeting views">
        <TabButton tab="agenda" activeTab={activeTab} onTabChange={onTabChange} label="Agenda" />
        <TabButton tab="queue" activeTab={activeTab} onTabChange={onTabChange} label="Queue" />
        <TabButton tab="help" activeTab={activeTab} onTabChange={onTabChange} label="Help" />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* User menu: Log Out in real OAuth, user-switcher in dev mode */}
      <UserMenu />
    </nav>
  );
}
