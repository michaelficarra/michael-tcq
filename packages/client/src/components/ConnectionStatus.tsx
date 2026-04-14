/**
 * Small fixed-position dot showing WebSocket connection status.
 * Green when connected, red when disconnected.
 *
 * When the connection transitions to disconnected, a "Connection lost"
 * tooltip appears. It dismisses on click or when reconnected.
 */

import { useState } from 'react';

interface ConnectionStatusProps {
  connected: boolean;
}

export function ConnectionStatus({ connected }: ConnectionStatusProps) {
  // Track the previous connected prop value, whether the tooltip is visible,
  // and whether the user has dismissed it. Using a single setState call to
  // detect prop transitions avoids refs and effects.
  const [state, setState] = useState({
    prevConnected: connected,
    tooltipVisible: false,
  });

  if (connected !== state.prevConnected) {
    if (state.prevConnected && !connected) {
      // Connected → disconnected: show tooltip
      setState({ prevConnected: connected, tooltipVisible: true });
    } else {
      // Disconnected → connected (or any other change): hide tooltip
      setState({ prevConnected: connected, tooltipVisible: false });
    }
  }

  return (
    <div className="fixed bottom-3 right-3 flex items-center gap-2">
      {state.tooltipVisible && (
        <button
          onClick={() => setState((s) => ({ ...s, tooltipVisible: false }))}
          className="bg-red-600 text-white text-xs px-2 py-1 rounded shadow cursor-pointer"
          aria-live="assertive"
        >
          Connection lost
        </button>
      )}
      <div
        className={`w-2.5 h-2.5 rounded-full transition-colors ${
          connected ? 'bg-green-500' : 'bg-red-500'
        }`}
        title={connected ? 'Connected' : 'Disconnected'}
        aria-label={connected ? 'Connected to server' : 'Disconnected from server'}
      />
    </div>
  );
}
