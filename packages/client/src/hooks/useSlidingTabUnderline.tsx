/**
 * Drives the teal underline that slides between the tabs of a tab strip
 * (the meeting NavBar and the home-page nav both use it).
 *
 * The underline is a single decorative element positioned absolutely within the
 * tablist and tethered to the active tab by measuring its geometry. It animates
 * via `transform`/`width` when the active tab changes, and snaps (no animation)
 * on the first placement and on layout reflows.
 *
 * Usage:
 *   const { tablistRef, registerTab, indicator } = useSlidingTabUnderline(activeKey);
 *   <div ref={tablistRef} className="relative …" role="tablist">
 *     {tabs.map(t => <Tab … onSpanRef={registerTab(t)} />)}
 *     {indicator}
 *   </div>
 *
 * Each tab must register the element whose bottom edge the underline should hug
 * (typically the inner <span> carrying the text) via `registerTab(key)`.
 */

import { useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react';

interface SlidingUnderline<T extends string> {
  /** Attach to the positioned (`relative`) tablist container. */
  tablistRef: RefObject<HTMLDivElement | null>;
  /** Returns a ref callback for the tab's measured element, keyed by tab. */
  registerTab: (key: T) => (el: HTMLElement | null) => void;
  /** The decorative underline element; render it as the last child of the tablist. */
  indicator: ReactElement;
}

export function useSlidingTabUnderline<T extends string>(activeKey: T): SlidingUnderline<T> {
  const tablistRef = useRef<HTMLDivElement>(null);
  // Each tab registers its measured element here so we can locate the active one.
  const tabRefs = useRef<Map<T, HTMLElement>>(new Map());
  // Geometry of the underline, relative to the tablist. null until first measured.
  // `animate` is true only when the move was caused by a tab switch, so the underline
  // appears in place on mount and snaps (not slides) on resize reflows.
  const [pos, setPos] = useState<{ top: number; left: number; width: number; animate: boolean } | null>(null);
  // Whether we've positioned the underline at least once (first placement must not animate).
  const positioned = useRef(false);

  useLayoutEffect(() => {
    const list = tablistRef.current;
    const el = tabRefs.current.get(activeKey);
    if (!list || !el) return;

    const update = (animate: boolean) => {
      const lr = list.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      // Sit the 2px indicator where the tab's transparent border-b-2 is.
      setPos({ top: er.bottom - lr.top - 2, left: er.left - lr.left, width: er.width, animate });
    };

    // A tab switch should slide; the very first placement should not.
    update(positioned.current);
    positioned.current = true;

    // Recompute (without sliding) when layout shifts — font load, window resize,
    // a tab appearing/disappearing, etc. ResizeObserver is absent in jsdom, so guard.
    const reflow = () => update(false);
    window.addEventListener('resize', reflow);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(reflow);
      ro.observe(list);
      ro.observe(el);
    }
    return () => {
      window.removeEventListener('resize', reflow);
      ro?.disconnect();
    };
  }, [activeKey]);

  const registerTab = (key: T) => (el: HTMLElement | null) => {
    if (el) tabRefs.current.set(key, el);
    else tabRefs.current.delete(key);
  };

  // Decorative only — aria-selected on the tabs is the real cue for assistive tech.
  const indicator = (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute left-0 h-0.5 bg-teal-500 ${
        pos?.animate ? 'motion-safe:transition-[transform,width] motion-safe:duration-200 motion-safe:ease-out' : ''
      }`}
      style={
        pos ? { top: pos.top, width: pos.width, transform: `translateX(${pos.left}px)`, opacity: 1 } : { opacity: 0 }
      }
    />
  );

  return { tablistRef, registerTab, indicator };
}
