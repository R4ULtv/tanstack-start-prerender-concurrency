import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { CPU_ITERATIONS, IO_WAIT_MS, ROW_COUNT, cpuRows, ioRows } from "../src/workload.ts";
import { renderReport } from "./report.mjs";

// Change these constants to change the experiment. No environment variables.
const CONCURRENCIES = [1, 2, 4, 8, 16];
const CASES = [
  { workload: "cpu", pageCount: 100 },
  { workload: "cpu", pageCount: 500 },
  { workload: "cpu", pageCount: 1_000 },
  { workload: "io", pageCount: 100 },
];
const REPEATS = 4;

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const output = path.join(root, "benchmark/results");
const settingsFile = path.join(root, "benchmark/.run.json");
const metricsFile = path.join(root, "benchmark/.metrics.json");
await mkdir(output, { recursive: true });
await Promise.all(["report.html", "results.csv"].map((name) => rm(path.join(output, name), { force: true })));
const lock = await readFile("package-lock.json", "utf8");
const lockPackages = JSON.parse(lock).packages;
const versions = {};
for (const name of ["@tanstack/react-start", "@tanstack/react-router", "@tanstack/start-plugin-core", "react", "react-dom", "vite", "@vitejs/plugin-react"]) {
  const installed = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8")).version;
  assert.equal(installed, lockPackages[`node_modules/${name}`].version, `Installed ${name} matches lockfile`);
  versions[name] = installed;
}
assert.equal(CONCURRENCIES[0], 1, "Include concurrency 1 as the baseline");
assert.equal(new Set(CONCURRENCIES).size, CONCURRENCIES.length);
// Rotate the starting condition every two repeats and reverse each paired order.
// Paired forward/reverse orders balance early and late build positions.
const orders = Array.from({ length: REPEATS }, (_, index) => {
  const offset = Math.floor(index / 2) * 2 % CONCURRENCIES.length;
  const order = [...CONCURRENCIES.slice(offset), ...CONCURRENCIES.slice(0, offset)];
  return index % 2 ? order.reverse() : order;
});
const report = {
  startedAt: new Date().toISOString(), completedAt: null,
  system: { node: process.version, platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, availableParallelism: os.availableParallelism(), memoryBytes: os.totalmem() },
  versions,
  lockfileSha256: createHash("sha256").update(lock).digest("hex"),
  methodology: {
    cases: CASES, concurrencies: CONCURRENCIES, repeats: REPEATS, orders,
    cpuIterations: CPU_ITERATIONS, ioWaitMs: IO_WAIT_MS, renderedRows: ROW_COUNT,
    warmup: "One unmeasured 20-page build per workload at concurrency 1 and the maximum tested concurrency. Fresh Node processes still have their own JIT warmup.",
    isolation: "Fresh Node process and removed dist directory per build. Dependencies and OS filesystem caches remain warm; the host is not otherwise isolated.",
    timing: "Prerender: internal start/end log markers after preview startup and before shutdown. Full build: Vite builder creation through buildApp completion; excludes Node/module startup, cleanup, and output validation.",
    cpuMetric: "process.cpuUsage delta during the prerender interval, user plus system time. CPU/wall is process CPU milliseconds divided by elapsed milliseconds; native threads are included, so this is not a count of SSR threads or isolates.",
    logging: "All conditions suppress the same per-page prerender log calls and use the same passive aggregate request observer.",
    redirects: "Benchmark uses trailingSlash: always and canonical slash-ended paths. Every page must return exactly one 200 response, with zero redirects. No request rewriting. The normal reproduction retains trailingSlash: never.",
    outputCheck: "Every page ID and all 200 rendered row values are checked against independently generated expected content outside the timed interval. Complete HTML SHA-256 digests must match across concurrency settings/repeats after replacing only serialized match update timestamps (u:<13-digit milliseconds>); other output assets must match byte-for-byte within each workload/page-count case.",
    limits: "Synthetic workloads on one local Node preview server. Async control uses setTimeout, not real network/storage. No custom worker pool, Cloudflare adapter, or deployment is measured. Speedups are relative to the same case at concurrency 1, not a comparison between workloads.",
  },
  warmups: [], runs: [],
};

// Precompute fixture expectations once; do not repeat CPU work in timed builds or
// validation. The fixture's algorithm and output are unchanged from the original.
console.log("Preparing deterministic expected page contents outside measured builds...");
const expectedLists = new Map();
for (const workload of new Set(CASES.map((item) => item.workload))) {
  const maxPages = Math.max(...CASES.filter((item) => item.workload === workload).map((item) => item.pageCount));
  expectedLists.set(workload, Array.from({ length: maxPages }, (_, id) =>
    "<ul>" + (workload === "cpu" ? cpuRows(id) : ioRows(id)).map((row) => `<li>${row}</li>`).join("") + "</ul>"));
}

async function validateOutput(workload, pageCount) {
  const pageDir = path.join(root, "dist/client/page");
  assert.equal((await readdir(pageDir)).length, pageCount, "Generated page count");
  const pageHash = createHash("sha256");
  for (let id = 0; id < pageCount; id++) {
    const directory = path.join(pageDir, String(id));
    assert.deepEqual(await readdir(directory), ["index.html"]);
    const html = await readFile(path.join(directory, "index.html"), "utf8");
    assert.ok(html.includes(`<h1>Page <!-- -->${id}</h1>`), `Page ID ${id}`);
    assert.ok(html.includes(expectedLists.get(workload)[id]), `All rendered rows for ${workload}/${id}`);
    pageHash.update(`${id}\0`);
    pageHash.update(html.replace(/\bu:\d{13}\b/g, "u:TIMESTAMP"));
    pageHash.update("\0");
  }
  const assetHash = createHash("sha256");
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (file === pageDir) continue;
      if (entry.isDirectory()) await walk(file);
      else { assetHash.update(path.relative(root, file) + "\0"); assetHash.update(await readFile(file)); assetHash.update("\0"); }
    }
  }
  await walk(path.join(root, "dist"));
  return { pageSha256: pageHash.digest("hex"), assetSha256: assetHash.digest("hex") };
}

async function run(testCase, concurrency, repeat, warmup = false) {
  const { workload, pageCount } = testCase;
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  await rm(metricsFile, { force: true });
  await writeFile(settingsFile, JSON.stringify({ workload, pageCount, concurrency, metricsFile }));
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["benchmark/build.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Build failed (${code})\n${stdout}\n${stderr}`)));
  });
  const timing = /^BENCHMARK_TIMING (.+)$/m.exec(stdout);
  assert.ok(timing, "Build reported timing");
  const metrics = JSON.parse(await readFile(metricsFile, "utf8"));
  assert.equal(metrics.exactRequestPaths, true);
  assert.equal(metrics.requests, pageCount);
  assert.deepEqual(metrics.responses, { 200: pageCount });
  assert.equal(metrics.activeAtClose, 0);
  assert.ok(metrics.peakActive >= 1 && metrics.peakActive <= concurrency);
  if (workload === "io" && concurrency > 1) assert.ok(metrics.peakActive > 1, "Async control actually overlaps preview requests");
  const measured = { workload, pageCount, concurrency, repeat, ...JSON.parse(timing[1]), ...metrics, ...await validateOutput(workload, pageCount) };
  const name = `${warmup ? "warmup" : "run"}-${workload}-${pageCount}-c${concurrency}-${repeat}`;
  await writeFile(path.join(output, name + ".log"), stdout + stderr);
  console.log(`${name}: prerender ${(measured.prerenderMs / 1000).toFixed(3)}s; build ${(measured.buildMs / 1000).toFixed(3)}s; CPU/wall ${(measured.prerenderCpuMs / measured.prerenderMs).toFixed(2)}; peak requests ${metrics.peakActive}; output verified`);
  return measured;
}

try {
  for (const workload of new Set(CASES.map((item) => item.workload))) {
    for (const concurrency of new Set([1, CONCURRENCIES.at(-1)])) {
      report.warmups.push(await run({ workload, pageCount: 20 }, concurrency, 0, true));
    }
  }
  for (const testCase of CASES) {
    let expectedOutput;
    for (let repeat = 1; repeat <= REPEATS; repeat++) {
      for (const concurrency of orders[repeat - 1]) {
        const measured = await run(testCase, concurrency, repeat);
        const digest = [measured.pageSha256, measured.assetSha256];
        if (expectedOutput) assert.deepEqual(digest, expectedOutput, "Outputs match across all concurrency settings and repeats");
        else expectedOutput = digest;
        report.runs.push(measured);
        await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
      }
    }
  }
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  await renderReport(report, output);
  console.log("Complete: benchmark/results/report.html");
} finally {
  await rm(settingsFile, { force: true });
  await rm(metricsFile, { force: true });
}
