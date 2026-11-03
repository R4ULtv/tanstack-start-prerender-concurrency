// Same deterministic synchronous work as the original reproduction. The returned
// values are rendered and serialized, so the computation cannot be discarded.
export const CPU_ITERATIONS = 500_000;
export const IO_WAIT_MS = 15;
export const ROW_COUNT = 200;

export function cpuRows(seed: number): number[] {
  let x = seed + 1;
  const rows: number[] = [];
  for (let i = 0; i < CPU_ITERATIONS; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    if (i % 2_500 === 0) rows.push(x);
  }
  return rows;
}

export function ioRows(seed: number): number[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => seed + index);
}

export function loadPage(id: string) {
  if (__PRERENDER_WORKLOAD__ === "io") {
    // An async-wait control, not a real network or storage benchmark.
    return new Promise<{ id: string; rows: number[] }>((resolve) => {
      setTimeout(() => resolve({ id, rows: ioRows(Number(id)) }), IO_WAIT_MS);
    });
  }
  return { id, rows: cpuRows(Number(id)) };
}
