/**
 * Top navigation bar shown on the meeting page.
 *
 * Layout mirrors the original: "TCQ" branding on the left, Agenda/Queue tab
 * toggles, and a Log Out link on the right.
 */

interface NavBarProps {
  activeTab: 'agenda' | 'queue';
  onTabChange: (tab: 'agenda' | 'queue') => void;
}

export function NavBar({ activeTab, onTabChange }: NavBarProps) {
  return (
    <nav
      className="flex items-center gap-6 border-b border-stone-200 bg-white px-6 py-3"
      aria-label="Main navigation"
    >
      {/* Branding */}
      <span className="text-2xl font-semibold text-stone-800 select-none">
        TCQ
      </span>

      {/* Tab toggles */}
      <div className="flex gap-4" role="tablist" aria-label="Meeting views">
        <button
          role="tab"
          aria-selected={activeTab === 'agenda'}
          aria-controls="panel-agenda"
          className={`text-base font-medium transition-colors ${
            activeTab === 'agenda'
              ? 'text-stone-900'
              : 'text-stone-400 hover:text-stone-600'
          }`}
          onClick={() => onTabChange('agenda')}
        >
          Agenda
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'queue'}
          aria-controls="panel-queue"
          className={`text-base font-medium transition-colors ${
            activeTab === 'queue'
              ? 'text-stone-900'
              : 'text-stone-400 hover:text-stone-600'
          }`}
          onClick={() => onTabChange('queue')}
        >
          Queue
        </button>
      </div>

      {/* Spacer pushes Log Out to the right */}
      <div className="flex-1" />

      {/* Log Out link — placeholder until OAuth is implemented */}
      <a
        href="/auth/logout"
        className="text-sm text-stone-500 hover:text-stone-700 transition-colors"
      >
        Log Out
      </a>
    </nav>
  );
}
