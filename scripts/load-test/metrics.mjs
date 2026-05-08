// JSONL metrics writer + percentile helpers.
//
// One file per run, one JSON object per line. Streaming writes so a long
// run doesn't accumulate samples in memory. Sample shape:
//
//   { ts: 1730000000000, category: 'probe', label: 'load-1', rttMs: 42 }
//
// `category` is a free-form string the harness uses to bucket samples
// when computing the summary at end-of-run.

import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function createMetrics(filePath) {
  if (!existsSync(dirname(filePath))) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const stream = createWriteStream(filePath, { flags: 'a' });
  const samples = []; // kept in-memory for end-of-run summary

  return {
    /** Append one sample. `ts` is auto-stamped. */
    write(category, data) {
      const sample = { ts: Date.now(), category, ...data };
      samples.push(sample);
      stream.write(JSON.stringify(sample) + '\n');
    },
    /**
     * Append a batch of pre-stamped samples in one shot. Used by the
     * parent to ingest worker batches over IPC without re-stamping or
     * paying per-sample function-call overhead. Each sample must
     * already have its `ts` and `category` set.
     */
    appendBatch(batch) {
      for (const sample of batch) {
        samples.push(sample);
        stream.write(JSON.stringify(sample) + '\n');
      }
    },
    /** Read back every sample written this run (for summary computation). */
    all() {
      return samples;
    },
    /** Flush and close. Resolves once the OS has acked the write. */
    close() {
      return new Promise((resolve) => stream.end(resolve));
    },
  };
}

/**
 * Compute a percentile from an unsorted numeric array. Uses the
 * "nearest rank" method — adequate for monitoring; we don't need the
 * exact NIST-compliant flavour.
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Convenience: { p50, p95, p99, max, count } over a numeric array. */
export function summariseLatency(values) {
  if (values.length === 0) return { count: 0 };
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(...values),
  };
}
