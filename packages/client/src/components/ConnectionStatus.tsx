/**
 * Small fixed-position dot showing WebSocket connection status.
 * Green when connected, red when disconnected.
 *
 * When the connection transitions to disconnected, a "Connection lost"
 * tooltip appears. It dismisses on click or when reconnected.
 *
 * While connected, hovering the dot reveals a pill showing the current
 * number of active socket connections to the meeting. The two pills are
 * mutually exclusive: one requires connected=true, the other
 * connected=false.
 */

import { useState } from 'react';

interface ConnectionStatusProps {
  connected: boolean;
  /** Number of active socket connections in the meeting room. */
  activeConnections: number;
}

export function ConnectionStatus({ connected, activeConnections }: ConnectionStatusProps) {
  // Track the previous connected prop value and whether the
  // "Connection lost" tooltip is visible. Using a single setState call
  // to detect prop transitions avoids refs and effects.
  const [state, setState] = useState({
    prevConnected: connected,
    tooltipVisible: false,
  });

  // Hover state for the active-connections pill.
  const [hovered, setHovered] = useState(false);

  if (connected !== state.prevConnected) {
    if (state.prevConnected && !connected) {
      // Connected → disconnected: show tooltip
      setState({ prevConnected: connected, tooltipVisible: true });
    } else {
      // Disconnected → connected (or any other change): hide tooltip
      setState({ prevConnected: connected, tooltipVisible: false });
    }
  }

  // Shared label used by the hover pill, the native title tooltip, and
  // the aria-label so all three surfaces show identical copy.
  const connectedLabel = `Connected — ${activeConnections} active connection${activeConnections === 1 ? '' : 's'}`;

  return (
    // Hover handlers live on the outer container rather than the 10px dot
    // so that (a) the activation hit target is expanded by the padding
    // below, avoiding sub-pixel flicker on a tiny dot, and (b) once the
    // pill becomes visible, the container grows to include it — moving the
    // cursor from the dot onto the pill (or through the flex gap) stays
    // within the container, so mouseLeave doesn't fire and the pill
    // doesn't flicker off and back on.
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // bottom-1/left-1 + p-2 keeps the dot visually at ~12px from the
      // viewport edge while giving the invisible container an extra 8px
      // of hit area on every side of the dot. Anchored on the left so the
      // dot doesn't overlap the vertical scrollbar on the right.
      //
      // flex-row-reverse so the dot sits on the left edge and the pills
      // grow rightward into the visible area; with plain row, the pills
      // (which precede the dot in DOM order) would extend off-screen to
      // the left.
      //
      // items-end (not items-center) so that when the taller pill appears,
      // the container grows upward while the dot stays pinned to the
      // bottom of the content area. With items-center, a taller item
      // would re-centre both and push the dot upward on hover.
      //
      // cursor-help lives on the container (when connected) so the help
      // cursor covers the whole active hit area — dot, gap, and pill —
      // rather than flipping back to the default when the cursor moves
      // off the 10px dot. The "Connection lost" button overrides with
      // cursor-pointer via its own className.
      className={`fixed bottom-1 left-1 p-2 flex flex-row-reverse items-end gap-2 ${connected ? 'cursor-help' : ''}`}
    >
      {state.tooltipVisible && (
        <button
          onClick={() => setState((s) => ({ ...s, tooltipVisible: false }))}
          className="bg-red-600 text-white text-xs px-2 py-1 rounded shadow cursor-pointer"
          aria-live="assertive"
        >
          Connection lost
        </button>
      )}
      {connected && hovered && (
        // Styled to match the "Connection lost" pill (same sizing/shape),
        // but with a neutral slate background so the user distinguishes
        // an informational tooltip from an error.
        <div className="bg-slate-700 text-white text-xs px-2 py-1 rounded shadow" role="tooltip">
          {connectedLabel}
        </div>
      )}
      <div
        className={`w-2.5 h-2.5 rounded-full transition-colors ${connected ? 'bg-green-500' : 'bg-red-500'}`}
        // Keep the same copy on the native title and aria-label so
        // keyboard/assistive users get the information without needing
        // mouse hover, and the three surfaces stay in sync.
        title={connected ? connectedLabel : 'Disconnected'}
        aria-label={connected ? connectedLabel : 'Disconnected from server'}
      />
    </div>
  );
}
