/**
 * Small fixed-position dot showing WebSocket connection status.
 * Green when connected, red when disconnected.
 *
 * When the connection transitions to disconnected, a "Connection lost"
 * tooltip appears. It auto-dismisses after 5 seconds or on click.
 */

import { useState, useEffect, useRef } from 'react';

interface ConnectionStatusProps {
  connected: boolean;
}

export function ConnectionStatus({ connected }: ConnectionStatusProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const prevConnected = useRef(connected);

  useEffect(() => {
    // Show tooltip only on transition from connected → disconnected
    if (prevConnected.current && !connected) {
      setShowTooltip(true);
    }

    // Hide tooltip when reconnected
    if (connected) {
      setShowTooltip(false);
    }

    prevConnected.current = connected;
  }, [connected]);

  return (
    <div className="fixed bottom-3 right-3 flex items-center gap-2">
      {showTooltip && (
        <button
          onClick={() => setShowTooltip(false)}
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
