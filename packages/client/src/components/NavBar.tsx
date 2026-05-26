/**
 * Top navigation bar shown on the meeting page.
 *
 * Layout: "TCQ" branding on the left, Agenda/Queue/Log/Help tab toggles,
 * and the user menu (Log out or dev user-switcher) on the right.
 */

import { Link } from 'react-router-dom';
import { UserMenu } from './UserMenu.js';
import { Logo } from './Logo.js';
import { useSlidingTabUnderline } from '../hooks/useSlidingTabUnderline.js';

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
  onSpanRef,
}: {
  tab: Tab;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  label: string;
  // Registers the inner <span> so NavBar can measure it to position the sliding underline.
  onSpanRef?: (el: HTMLElement | null) => void;
}) {
  const isActive = activeTab === tab;
  // Rendered as an <a> (rather than a <button>) so middle-click and modifier-
  // click fall through to the browser and open the tab's URL in a new tab.
  // The outer anchor provides the full-nav-height click area (py-3); the inner
  // span carries the active-state underline so it stays close to the text.
  return (
    <a
      role="tab"
      href={`#${tab}`}
      aria-selected={isActive}
      aria-controls={`panel-${tab}`}
      className={`group flex items-center py-3 text-base font-medium cursor-pointer transition-colors ${
        isActive
          ? 'text-stone-900 dark:text-stone-100'
          : 'text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100'
      }`}
      onClick={(e) => {
        // Let modifier-clicks (Ctrl/Cmd/Shift/Alt) fall through to the browser
        // so they open in a new tab/window. Middle-click fires `auxclick`, not
        // `click`, so it's already handled natively.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onTabChange(tab);
      }}
    >
      {/*
        The active tab's teal underline is drawn by the single sliding indicator in NavBar
        (so it can animate between tabs), not by this border. All tabs keep a transparent
        border-b-2 to reserve the space and to host the faint hover hint on inactive tabs.
      */}
      <span
        ref={onSpanRef}
        className={`pb-1 border-b-2 transition-colors ${
          isActive
            ? 'border-transparent'
            : 'border-transparent group-hover:border-stone-300 dark:group-hover:border-stone-600'
        }`}
      >
        {label}
      </span>
    </a>
  );
}

export function NavBar({ activeTab, onTabChange }: NavBarProps) {
  const { tablistRef, registerTab, indicator } = useSlidingTabUnderline(activeTab);

  return (
    <nav
      className="scrollbar-hide shrink-0 z-50 flex items-stretch gap-3 sm:gap-6 border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 sm:px-6 overflow-x-auto shadow-md"
      aria-label="Main navigation"
    >
      {/* Branding */}
      <Link to="/" className="shrink-0 flex items-center py-3">
        <Logo hideTextOnSmallScreens />
      </Link>

      {/* Tab toggles — active tab has a teal underline that slides between tabs */}
      <div
        ref={tablistRef}
        className="relative flex shrink-0 items-stretch gap-4"
        role="tablist"
        aria-label="Meeting views"
      >
        {(['agenda', 'queue', 'log', 'help'] as const).map((tab) => (
          <TabButton
            key={tab}
            tab={tab}
            activeTab={activeTab}
            onTabChange={onTabChange}
            label={tab.charAt(0).toUpperCase() + tab.slice(1)}
            onSpanRef={registerTab(tab)}
          />
        ))}
        {/* Decorative sliding underline tracking the active tab. */}
        {indicator}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* User menu: Log out in real OAuth, user-switcher in dev mode */}
      <div className="shrink-0 flex items-stretch">
        <UserMenu />
      </div>
    </nav>
  );
}
