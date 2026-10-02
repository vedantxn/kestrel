/** Percentile by the nearest-rank method, on a copy. Returns NaN for no data. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function summarize(values: number[]): Summary {
  const n = values.length;
  return {
    n,
    min: n ? Math.min(...values) : NaN,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: n ? Math.max(...values) : NaN,
    mean: n ? values.reduce((a, b) => a + b, 0) / n : NaN,
  };
}
