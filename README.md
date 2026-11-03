# TanStack Start: prerender concurrency on CPU-bound pages

Reproduction and repeated benchmark for
[TanStack/router#8483](https://github.com/TanStack/router/issues/8483).
The benchmark distinguishes overlapping asynchronous waits from parallel JavaScript
CPU execution, without assuming that higher concurrency means more CPU workers.

## Minimal reproduction

Requires Node.js 22.18+ (tested on Node.js 24.22.2).

```sh
npm ci
npm run build
```

One route, `/page/$id`, runs 500,000 deterministic arithmetic iterations in its
loader and renders the resulting 200 rows. This is the same synchronous CPU work
as the original reproduction, with no external data fetching or artificial delay.
The route loader has no filesystem I/O; the prerenderer still writes HTML to disk.

`PAGE_COUNT` and `CONCURRENCY` are constants in `vite.config.ts` (defaults: 1,000
pages and concurrency 1). Edit them directly for individual builds.

## Repeated benchmark

```sh
npm run bench
```

The full experiment runs **80 measured builds**, plus four warmups. The recorded
run took about 13 minutes on an Apple M4. Settings are constants in `benchmark/run.mjs`;
no environment variables are needed.

| Workload | Pages | Concurrency | Repeats per condition |
| --- | --- | --- | --- |
| Original CPU work | 100, 500, 1,000 | 1, 2, 4, 8, 16 | 4 |
| Async-wait control | 100 | 1, 2, 4, 8, 16 | 4 |

The control waits on one 15 ms timer and then renders 200 inexpensive deterministic
rows. It checks that request concurrency actually overlaps waiting. It does not
model real network/storage latency or provide an equal-work CPU comparison.

Each condition records:

- Prerender-phase wall time, separately from full-build wall time.
- Process CPU time during prerender and its ratio to elapsed time. This includes
  native threads; it does not count SSR threads, workers, or isolates.
- Exact HTTP request paths/counts/statuses and peak simultaneous preview requests.
- Verified output hashes and the generated page count.

### Controls for noise and correctness

- Each build runs in a fresh Node process after deleting `dist`. Dependencies and
  OS caches remain warm; this is not a cache-cold or dedicated-machine experiment.
- Four unmeasured 20-page builds cover both workloads at concurrency 1 and 16.
  Every fresh process still has its own JIT warmup.
- Four runs per condition use rotated forward/reverse orders, balancing early and
  late build positions. The report records the exact sequence.
- All conditions suppress the same per-page prerender log calls and use the same
  passive aggregate preview observer.
- The benchmark uses `trailingSlash: 'always'` and canonical slash-ended URLs.
  Every page must produce exactly one request and one `200`, with zero redirects.
  This excludes the separate redirect overhead tracked by
  [#8850](https://github.com/TanStack/router/issues/8850). The ordinary reproduction
  build retains `trailingSlash: 'never'`; no middleware rewrites requests.
- Every generated page ID and all 200 rendered row values are checked against
  expected content prepared once outside the timed builds. Complete HTML hashes
  must match across concurrency settings and repeats, after normalizing only
  serialized match-update timestamps. Other built assets must match byte-for-byte
  within each workload/page-count case.

Prerender time is measured between TanStack's internal start/end log markers,
after preview startup and before shutdown. Full-build time covers Vite builder
creation through build completion, including bundling, preview startup, prerender,
and shutdown. Node/module startup, cleanup, and output validation are excluded.

## Recorded report and raw data

Recorded median prerender times on the test machine:

| Workload | Concurrency 1 | Concurrency 16 | Speedup vs 1 |
| --- | --- | --- | --- |
| CPU, 1,000 pages | 21.258 s | 20.849 s | 1.02× |
| Async wait, 100 pages | 1.974 s | 0.232 s | 8.50× |

The CPU result stays close to the baseline, while the async control shows that
concurrency does overlap waiting. These are separate workloads, each compared
with its own concurrency-1 baseline. See the report for all page counts,
concurrency values, individual runs, and ranges.

- [Self-contained HTML report](./benchmark/results/report.html): workload and
  timing selectors, all measured points, medians and min–max ranges, individual
  runs, hardware/software details, and embedded source data. Can be attached as an
  HTML issue artifact; no external assets required.
- [Raw JSON](./benchmark/results/results.json): all measurements, warmups,
  methodology, request checks, and output digests.
- [CSV](./benchmark/results/results.csv): every measured run.

These replace the original three single-run timing samples. Speedups compare
medians against concurrency 1 within the same workload and page count. No runs are
discarded as outliers. Results do not predict production or Cloudflare build times,
and do not measure deployment or an implementation using several preview workers.

```sh
# Regenerate HTML and CSV from recorded JSON without rerunning builds.
npm run bench:report

# Run after build/bench has generated src/routeTree.gen.ts.
npm run check-types
```

A new benchmark run overwrites result files. Per-run logs remain local and ignored.
The benchmark stops if timings, request counts, or output comparisons fail.

## Dependency versions

Direct dependencies are pinned to the versions in the original lockfile; this
update improves the experiment without upgrading the framework under test.

- `@tanstack/react-start`: 1.168.57
- `@tanstack/react-router`: 1.170.38
- `@tanstack/start-plugin-core` (transitive): 1.171.47
- React / React DOM: 19.3.0
- Vite: 8.3.0

For CPU-bound pages, a separate option that spreads rendering across preview
processes/threads could be useful. The existing concurrency setting can still help
with asynchronous waiting and other I/O overhead; the report measures both cases.
