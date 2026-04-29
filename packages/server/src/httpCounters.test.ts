import { describe, it, expect, beforeEach } from 'vitest';
import { recordHttpResponse, getHttpCounters, resetHttpCounters } from './httpCounters.js';

describe('httpCounters', () => {
  beforeEach(() => {
    resetHttpCounters();
  });

  it('starts at zero', () => {
    expect(getHttpCounters()).toEqual({ total: 0, clientErrors: 0, serverErrors: 0 });
  });

  it('counts each response toward the total', () => {
    recordHttpResponse(200);
    recordHttpResponse(204);
    recordHttpResponse(301);
    expect(getHttpCounters()).toEqual({ total: 3, clientErrors: 0, serverErrors: 0 });
  });

  it('classifies 4xx as client errors', () => {
    recordHttpResponse(400);
    recordHttpResponse(404);
    recordHttpResponse(499);
    expect(getHttpCounters()).toEqual({ total: 3, clientErrors: 3, serverErrors: 0 });
  });

  it('classifies 5xx as server errors', () => {
    recordHttpResponse(500);
    recordHttpResponse(503);
    expect(getHttpCounters()).toEqual({ total: 2, clientErrors: 0, serverErrors: 2 });
  });

  it('does not double-count: a single response only bumps one error bucket', () => {
    recordHttpResponse(200);
    recordHttpResponse(404);
    recordHttpResponse(500);
    expect(getHttpCounters()).toEqual({ total: 3, clientErrors: 1, serverErrors: 1 });
  });
});
