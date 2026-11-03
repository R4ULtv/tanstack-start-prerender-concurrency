import { performance } from "node:perf_hooks";
import { createBuilder } from "vite";

let start;
let end;
let cpuStart;
let cpu;
const info = console.info;
console.info = (...args) => {
  if (args[0] !== "[prerender]") return info(...args);
  if (args[1] === "Prerendering pages...") {
    start = performance.now();
    cpuStart = process.cpuUsage();
  }
  if (/^Prerendered \d+ pages:$/.test(args[1])) {
    end = performance.now();
    cpu = process.cpuUsage(cpuStart);
  }
  // Suppress identical per-page log calls in all runs.
};

const buildStart = performance.now();
const builder = await createBuilder({ configFile: "benchmark/vite.config.ts", logLevel: "silent" });
await builder.buildApp();
const buildEnd = performance.now();
if (start === undefined || end === undefined || cpu === undefined) {
  throw new Error("Prerender timing markers missing; update the benchmark for this version.");
}
console.log("BENCHMARK_TIMING " + JSON.stringify({
  prerenderMs: end - start,
  buildMs: buildEnd - buildStart,
  prerenderCpuMs: (cpu.user + cpu.system) / 1000,
}));
