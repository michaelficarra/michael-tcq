import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

const sample = {
  process: {
    uptimeSeconds: 90_061, // 1d 1h 1m
    cpuSeconds: 3_661.5, // 1h 1m — lagging uptime, simulating a throttled host
    nodeVersion: 'v22.12.0',
    gitSha: 'abc123def4567890',
    memory: { rss: 200 * 1024 * 1024, heapUsed: 50 * 1024 * 1024, heapTotal: 80 * 1024 * 1024, external: 0 },
  },
  meetings: { totalActive: 3, totalParticipants: 27, totalConnections: 18 },
  sockets: { totalClients: 21 },
  http: { total: 1234, clientErrors: 12, serverErrors: 4 },
  persistence: {
    lastSyncSucceededAt: '2026-04-29T09:55:00.000Z',
    lastSyncFailedAt: null,
    lastSyncError: null,
    dirtyCount: 0,
  },
  errors: {
    totalSinceStart: 2,
    recent: [
      { timestamp: '2026-04-26T10:00:00.000Z', severity: 'CRITICAL', message: 'process_panic' },
      { timestamp: '2026-04-26T09:59:00.000Z', severity: 'ERROR', message: 'http_request_error', detail: 'oops' },
    ],
  },
};

describe('DiagnosticsPanel', () => {
  it('renders nothing while loading', () => {
    // fetch never resolves, so the component stays in loading state
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { container } = render(<DiagnosticsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders process, meetings, and socket stats after loading', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sample) });
    render(<DiagnosticsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Admin — Diagnostics')).toBeInTheDocument();
    });

    expect(screen.getByText('1d 1h 1m')).toBeInTheDocument();
    // CPU time floors to 3661s → "1h 1m" — distinct from uptime so we
    // can verify the wall-clock-vs-active-time gap is rendered.
    expect(screen.getByText('CPU time').nextSibling?.textContent).toBe('1h 1m');
    expect(screen.getByText('v22.12.0')).toBeInTheDocument();
    // SHA is truncated to 12 chars.
    expect(screen.getByText('abc123def456')).toBeInTheDocument();
    // Meeting aggregates appear by their adjacent label.
    expect(screen.getByText('Active meetings').nextSibling?.textContent).toBe('3');
    expect(screen.getByText('Total participants').nextSibling?.textContent).toBe('27');
    expect(screen.getByText('Live meeting connections').nextSibling?.textContent).toBe('18');
    expect(screen.getByText('Total Socket.IO clients').nextSibling?.textContent).toBe('21');
  });

  it('renders an em-dash when no git SHA is deployed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...sample, process: { ...sample.process, gitSha: null } }),
    });
    render(<DiagnosticsPanel />);
    await waitFor(() => {
      expect(screen.getByText('Git SHA').nextSibling?.textContent).toBe('—');
    });
  });

  it('shows "No errors recorded." when the buffer is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...sample, errors: { totalSinceStart: 0, recent: [] } }),
    });
    render(<DiagnosticsPanel />);
    await waitFor(() => {
      expect(screen.getByText(/no errors recorded/i)).toBeInTheDocument();
    });
  });

  it('renders HTTP counters and an error rate', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sample) });
    render(<DiagnosticsPanel />);

    await waitFor(() => {
      expect(screen.getByText('HTTP (since start)')).toBeInTheDocument();
    });
    expect(screen.getByText('Total responses').nextSibling?.textContent).toBe('1,234');
    // (12 + 4) / 1234 → 1.3%
    expect(screen.getByText('Error rate').nextSibling?.textContent).toBe('1.3%');
  });

  it('renders persistence health and flags an active outage', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...sample,
          persistence: {
            lastSyncSucceededAt: '2026-04-29T09:00:00.000Z',
            lastSyncFailedAt: '2026-04-29T09:30:00.000Z',
            lastSyncError: 'firestore unreachable',
            dirtyCount: 4,
          },
        }),
    });
    render(<DiagnosticsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Persistence')).toBeInTheDocument();
    });
    expect(screen.getByText('Dirty backlog').nextSibling?.textContent).toBe('4');
    expect(screen.getByText('firestore unreachable')).toBeInTheDocument();
  });

  it('renders recent errors with severity badges', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sample) });
    render(<DiagnosticsPanel />);

    await waitFor(() => {
      expect(screen.getByText('process_panic')).toBeInTheDocument();
    });
    expect(screen.getByText('CRIT')).toBeInTheDocument();
    expect(screen.getByText('ERR')).toBeInTheDocument();
    expect(screen.getByText(/oops/)).toBeInTheDocument();
    expect(screen.getByText(/2 since start/)).toBeInTheDocument();
  });
});
