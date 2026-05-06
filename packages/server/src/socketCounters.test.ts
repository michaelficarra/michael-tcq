import { describe, it, expect, beforeEach } from 'vitest';
import { recordStateResync, getSocketCounters, resetSocketCounters } from './socketCounters.js';

describe('socketCounters', () => {
  beforeEach(() => {
    resetSocketCounters();
  });

  it('starts at zero', () => {
    expect(getSocketCounters()).toEqual({ stateResyncs: 0 });
  });

  it('increments on each state:resync', () => {
    recordStateResync();
    recordStateResync();
    recordStateResync();
    expect(getSocketCounters()).toEqual({ stateResyncs: 3 });
  });
});
