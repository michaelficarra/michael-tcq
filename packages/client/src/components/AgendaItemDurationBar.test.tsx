import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AgendaItemDurationBar } from './AgendaItemDurationBar.js';

/**
 * Tests cover the bar's segment layout for the cases that meaningfully
 * affect users: capacity-fitting, capacity-overflowing, mid-elapsed, and
 * over-estimate. Heights are checked as percentages of the row so the
 * dynamic-rescale behaviour is exercised when elapsed crosses the
 * estimate.
 */
function readSegments(container: HTMLElement) {
  const bar = container.querySelector('[data-testid="agenda-duration-bar"]');
  if (!bar) return null;
  // Map of testid → height percentage (parsed from inline `style`)
  const heights: Record<string, number> = {};
  const titles: Record<string, string | null> = {};
  for (const seg of Array.from(bar.children) as HTMLElement[]) {
    const id = seg.getAttribute('data-testid') ?? '';
    const styleHeight = seg.style.height; // e.g. "42.5%"
    heights[id] = Number.parseFloat(styleHeight);
    titles[id] = seg.getAttribute('title');
  }
  return { bar, heights, titles, order: Array.from(bar.children).map((el) => el.getAttribute('data-testid')) };
}

describe('AgendaItemDurationBar', () => {
  it('renders nothing when the row is not in a session run', () => {
    const { container } = render(<AgendaItemDurationBar durationMinutes={20} overflowAmount={0} isIndented={false} />);
    expect(container.querySelector('[data-testid="agenda-duration-bar"]')).toBeNull();
  });

  it('renders nothing when no duration is set', () => {
    const { container } = render(
      <AgendaItemDurationBar durationMinutes={undefined} overflowAmount={0} isIndented={true} />,
    );
    expect(container.querySelector('[data-testid="agenda-duration-bar"]')).toBeNull();
  });

  it('renders a full-height light-gray segment for an item that fits entirely within capacity', () => {
    const { container } = render(<AgendaItemDurationBar durationMinutes={20} overflowAmount={0} isIndented={true} />);
    const segments = readSegments(container)!;
    expect(segments.order).toEqual(['bar-segment-light-gray']);
    expect(segments.heights['bar-segment-light-gray']).toBeCloseTo(100, 5);
  });

  it('splits gray (capacity) and red (overflow) proportionally when the item overflows', () => {
    // Estimate 20m, of which 5m sits past capacity → 75% gray, 25% red.
    const { container } = render(<AgendaItemDurationBar durationMinutes={20} overflowAmount={5} isIndented={true} />);
    const segments = readSegments(container)!;
    expect(segments.order).toEqual(['bar-segment-light-gray', 'bar-segment-light-red']);
    expect(segments.heights['bar-segment-light-gray']).toBeCloseTo(75, 5);
    expect(segments.heights['bar-segment-light-red']).toBeCloseTo(25, 5);
    expect(segments.titles['bar-segment-light-red']).toBe('Overflows by 5m');
  });

  it('renders a full-height red segment for an item that sits entirely past capacity', () => {
    // overflowAmount === durationMinutes → containedMin = 0 → only red.
    const { container } = render(<AgendaItemDurationBar durationMinutes={10} overflowAmount={10} isIndented={true} />);
    const segments = readSegments(container)!;
    expect(segments.order).toEqual(['bar-segment-light-red']);
    expect(segments.heights['bar-segment-light-red']).toBeCloseTo(100, 5);
  });

  it('shades the elapsed portion dark within the capacity band', () => {
    // 20m estimate, no overflow, 5m elapsed → 25% dark gray + 75% light gray.
    const { container } = render(
      <AgendaItemDurationBar durationMinutes={20} overflowAmount={0} isIndented={true} elapsedMs={5 * 60_000} />,
    );
    const segments = readSegments(container)!;
    expect(segments.order).toEqual(['bar-segment-dark-gray', 'bar-segment-light-gray']);
    expect(segments.heights['bar-segment-dark-gray']).toBeCloseTo(25, 5);
    expect(segments.heights['bar-segment-light-gray']).toBeCloseTo(75, 5);
  });

  it('darkens the red band as elapsed crosses the capacity line', () => {
    // 20m estimate with 5m overflow → containedMin=15, overflowMin=5.
    // Elapsed 17m → dark-gray = 15m (75%), dark-red = 2m (10%), light-red = 3m (15%).
    const { container } = render(
      <AgendaItemDurationBar durationMinutes={20} overflowAmount={5} isIndented={true} elapsedMs={17 * 60_000} />,
    );
    const segments = readSegments(container)!;
    expect(segments.order).toEqual(['bar-segment-dark-gray', 'bar-segment-dark-red', 'bar-segment-light-red']);
    expect(segments.heights['bar-segment-dark-gray']).toBeCloseTo(75, 5);
    expect(segments.heights['bar-segment-dark-red']).toBeCloseTo(10, 5);
    expect(segments.heights['bar-segment-light-red']).toBeCloseTo(15, 5);
    // Both red segments share the same overflow tooltip.
    expect(segments.titles['bar-segment-dark-red']).toBe('Overflows by 5m');
    expect(segments.titles['bar-segment-light-red']).toBe('Overflows by 5m');
  });

  it('rescales to max(estimate, elapsed) and appends an orange segment once elapsed > estimate', () => {
    // 10m estimate, no overflow, 15m elapsed → totalMin = 15.
    // dark-gray = 10/15 ≈ 66.67%, orange = 5/15 ≈ 33.33%.
    const { container } = render(
      <AgendaItemDurationBar durationMinutes={10} overflowAmount={0} isIndented={true} elapsedMs={15 * 60_000} />,
    );
    const segments = readSegments(container)!;
    expect(segments.order).toEqual(['bar-segment-dark-gray', 'bar-segment-orange']);
    expect(segments.heights['bar-segment-dark-gray']).toBeCloseTo(66.67, 1);
    expect(segments.heights['bar-segment-orange']).toBeCloseTo(33.33, 1);
    // Orange tooltip uses M:SS formatting for the over-estimate amount.
    expect(segments.titles['bar-segment-orange']).toBe('Over estimate by 5:00');
  });

  it('renders dark gray + dark red + orange when elapsed has fully consumed an overflowing estimate', () => {
    // 10m estimate with 4m overflow (containedMin=6, overflowMin=4),
    // elapsed 12m → totalMin = 12. Heights:
    //   dark-gray  = 6/12 = 50%
    //   dark-red   = 4/12 ≈ 33.33%
    //   orange     = 2/12 ≈ 16.67%
    const { container } = render(
      <AgendaItemDurationBar durationMinutes={10} overflowAmount={4} isIndented={true} elapsedMs={12 * 60_000} />,
    );
    const segments = readSegments(container)!;
    expect(segments.order).toEqual(['bar-segment-dark-gray', 'bar-segment-dark-red', 'bar-segment-orange']);
    expect(segments.heights['bar-segment-dark-gray']).toBeCloseTo(50, 5);
    expect(segments.heights['bar-segment-dark-red']).toBeCloseTo(33.33, 1);
    expect(segments.heights['bar-segment-orange']).toBeCloseTo(16.67, 1);
  });

  it('sums all segment heights to 100% of the row, regardless of state', () => {
    const cases = [
      { durationMinutes: 20, overflowAmount: 0, elapsedMs: 0 },
      { durationMinutes: 20, overflowAmount: 5, elapsedMs: 0 },
      { durationMinutes: 20, overflowAmount: 5, elapsedMs: 17 * 60_000 },
      { durationMinutes: 10, overflowAmount: 0, elapsedMs: 15 * 60_000 },
      { durationMinutes: 10, overflowAmount: 4, elapsedMs: 12 * 60_000 },
    ];
    for (const c of cases) {
      const { container, unmount } = render(<AgendaItemDurationBar isIndented={true} {...c} />);
      const segments = readSegments(container)!;
      const sum = Object.values(segments.heights).reduce((acc, v) => acc + v, 0);
      expect(sum).toBeCloseTo(100, 1);
      unmount();
    }
  });
});
