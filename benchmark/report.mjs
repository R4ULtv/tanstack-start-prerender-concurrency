import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function summarize(report) {
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, min: sorted[0], max: sorted.at(-1), values };
  };
  return report.methodology.cases.map((testCase) => ({
    ...testCase,
    conditions: report.methodology.concurrencies.map((concurrency) => {
      const runs = report.runs.filter((run) => run.workload === testCase.workload && run.pageCount === testCase.pageCount && run.concurrency === concurrency);
      if (runs.length !== report.methodology.repeats) throw new Error("Incomplete benchmark case");
      return {
        concurrency,
        prerenderMs: stats(runs.map((run) => run.prerenderMs)),
        buildMs: stats(runs.map((run) => run.buildMs)),
        cpuRatio: stats(runs.map((run) => run.prerenderCpuMs / run.prerenderMs)),
        peakActive: stats(runs.map((run) => run.peakActive)),
      };
    }),
  }));
}

export async function renderReport(report, directory) {
  if (!report.completedAt) throw new Error("Cannot render incomplete results");
  const cases = summarize(report);
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const n = (value) => value.toLocaleString("en-US");
  const seconds = (value) => (value / 1000).toFixed(3);
  const key = (item) => `${item.workload}-${item.pageCount}`;
  const name = (item) => `${item.workload === "cpu" ? "CPU-bound" : "Async-wait control"} · ${n(item.pageCount)} pages`;
  const color = (item) => item.workload === "cpu" ? "var(--chart-1, #326cd6)" : "var(--chart-2, #16836a)";
  const largest = cases.filter((item) => item.workload === "cpu").at(-1);
  const base = largest.conditions[0];
  const high = largest.conditions.at(-1);
  const control = cases.find((item) => item.workload === "io");
  const cpuSpeedup = base.prerenderMs.median / high.prerenderMs.median;
  const ioSpeedup = control.conditions[0].prerenderMs.median / control.conditions.at(-1).prerenderMs.median;

  function chart(item, metric, w) {
    const compact = w < 500;
    const h = 300, left = compact ? 42 : 54, right = 10, top = 34, bottom = 46;
    const max = Math.max(...item.conditions.map((row) => row[metric].max)) * 1.2;
    const y = (value) => top + (1 - value / max) * (h - top - bottom);
    const group = (w - left - right) / item.conditions.length;
    const half = compact ? 11 : 24;
    const marks = [];
    for (let tick = 0; tick <= 4; tick++) {
      const value = max * tick / 4;
      marks.push(`<line x1="${left}" x2="${w - right}" y1="${y(value)}" y2="${y(value)}" class="grid"/><text x="${left - 8}" y="${y(value) + 4}" text-anchor="end">${(value / 1000).toFixed(max < 2000 ? 2 : 1)}</text>`);
    }
    item.conditions.forEach((row, index) => {
      const x = left + group * (index + .5);
      const data = row[metric];
      marks.push(`<text x="${x}" y="${h - 23}" text-anchor="middle">${row.concurrency}</text><g fill="${color(item)}" stroke="${color(item)}"><title>Concurrency ${row.concurrency}: median ${seconds(data.median)} s; range ${seconds(data.min)}–${seconds(data.max)} s</title><rect x="${x - half}" y="${y(data.median)}" width="${half * 2}" height="${y(0) - y(data.median)}" opacity=".25" stroke="none"/><path d="M${x} ${y(data.min)}V${y(data.max)} M${x - 5} ${y(data.min)}H${x + 5} M${x - 5} ${y(data.max)}H${x + 5}" fill="none" stroke-width="1.5"/>${data.values.map((value, i) => `<circle cx="${x + (i - 1.5) * 3}" cy="${y(value)}" r="2.5" stroke="none"/>`).join("")}<path d="M${x - half} ${y(data.median)}H${x + half}" stroke-width="2.5"/><text class="value" x="${x}" y="${y(data.max) - 9}" text-anchor="middle" stroke="none">${(data.median / 1000).toFixed(2)}</text></g>`);
    });
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(name(item))}, ${metric === "prerenderMs" ? "prerender" : "full build"} time by concurrency. Bars show medians, dots show all runs, whiskers show minimum and maximum."><text x="${left}" y="14">Seconds · lower is faster</text>${marks.join("")}<text x="${(left + w - right) / 2}" y="${h - 3}" text-anchor="middle">prerender.concurrency</text></svg>`;
  }

  const views = cases.flatMap((item) => ["prerenderMs", "buildMs"].map((metric) => {
    const baseline = item.conditions[0][metric].median;
    return `<section data-case="${key(item)}" data-view-metric="${metric}" ${item === largest && metric === "prerenderMs" ? "" : "hidden"}><h2>${escape(name(item))}</h2><div class="desktop-chart">${chart(item, metric, 720)}</div><div class="mobile-chart">${chart(item, metric, 360)}</div><div class="scroll"><table><thead><tr><th>Concurrency</th><th>Median</th><th>Min–max</th><th>Speedup vs 1</th><th>CPU / wall¹</th><th>Peak HTTP²</th></tr></thead><tbody>${item.conditions.map((row) => `<tr><th>${row.concurrency}</th><td>${seconds(row[metric].median)} s</td><td>${seconds(row[metric].min)}–${seconds(row[metric].max)} s</td><td>${(baseline / row[metric].median).toFixed(2)}×</td><td>${row.cpuRatio.median.toFixed(2)}</td><td>${row.peakActive.min === row.peakActive.max ? row.peakActive.max : `${row.peakActive.min}–${row.peakActive.max}`}</td></tr>`).join("")}</tbody></table></div></section>`;
  })).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TanStack Start — prerender concurrency benchmark</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;color:var(--foreground,light-dark(#18212c,#e3e8ef));font:14px/1.55 var(--font-sans,system-ui,sans-serif)}main{max-width:940px;margin:auto}h1{font-size:24px;line-height:1.25;letter-spacing:-.025em;margin:20px 0 10px}h2{font-size:17px;margin:22px 0 8px}p{margin:8px 0 14px}.muted,small{color:var(--muted-foreground,light-dark(#536170,#abb7c6))}code,pre{font-family:var(--font-mono,ui-monospace,monospace);font-size:12px}code{overflow-wrap:anywhere}.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:16px 0}.controls label{display:flex;gap:6px;align-items:center}button,select{color:inherit;background:var(--secondary,light-dark(#eef2f6,#263140));border:1px solid var(--border,light-dark(#cdd5df,#465365));border-radius:var(--radius,6px);padding:7px 10px;font:inherit}button{cursor:pointer}button[aria-pressed="true"]{font-weight:650;border-color:var(--foreground,light-dark(#18212c,#e3e8ef))}button:focus-visible,select:focus-visible{outline:2px solid var(--ring,#4e88db);outline-offset:3px}svg{display:block;width:100%;height:300px;overflow:visible}svg text{font-size:12px;font-family:var(--font-sans,system-ui,sans-serif);fill:var(--muted-foreground,light-dark(#536170,#abb7c6))}svg .value{font-weight:650;font-size:11px;fill:var(--foreground,light-dark(#18212c,#e3e8ef))}.grid{stroke:var(--border,light-dark(#dce2e9,#364354));stroke-width:1}.mobile-chart{display:none}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:9px 10px 9px 0;text-align:right;border-bottom:1px solid var(--border,light-dark(#dce2e9,#364354));white-space:nowrap}th:first-child,td:first-child{text-align:left}thead th{font-size:12px;font-weight:550}ul{padding-left:20px}li{margin:7px 0}details{margin:16px 0}summary{cursor:pointer;font-weight:600}pre{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}a{color:var(--info,light-dark(#245fbd,#8ab8ff))}[hidden]{display:none!important}@media(max-width:480px){h1{font-size:21px}.desktop-chart{display:none}.mobile-chart{display:block}}
</style></head><body><main><h1>Prerender concurrency: CPU work and async waiting</h1>
<p>Repeated local builds of the same route at concurrency ${report.methodology.concurrencies.join(", ")}. The original synchronous CPU workload is preserved; an async-wait control checks I/O overlap.</p>
<p><strong>${cpuSpeedup.toFixed(2)}× CPU-workload speedup</strong> at ${n(largest.pageCount)} pages, concurrency ${high.concurrency} vs 1. The async-wait control at ${n(control.pageCount)} pages measured <strong>${ioSpeedup.toFixed(2)}×</strong> over the same concurrency comparison. Each speedup uses its own case's median prerender time.</p>
<div class="controls"><label for="case-select">Workload <select id="case-select">${cases.map((item) => `<option value="${key(item)}" ${item === largest ? "selected" : ""}>${escape(name(item))}</option>`).join("")}</select></label><div role="group" aria-label="Timing metric"><button type="button" data-metric="prerenderMs" aria-pressed="true">Prerender phase</button> <button type="button" data-metric="buildMs" aria-pressed="false">Full build</button></div></div>
${views}<p class="muted">Bars and labels: median of ${report.methodology.repeats} runs. Dots: every measurement. Whiskers: minimum–maximum. Negative/noisy differences are retained; no extrapolated values.</p>
<p class="muted">¹ Median process CPU / elapsed time during prerender, including native threads. This is not a count of SSR threads or isolates. ² Maximum simultaneously active preview HTTP requests per run; ranges show variation between runs. These diagnostics always refer to the prerender phase.</p>
<h2>Workloads and controls</h2><ul><li><strong>CPU:</strong> ${n(report.methodology.cpuIterations)} deterministic arithmetic iterations and ${report.methodology.renderedRows} rendered rows per page, matching the original reproduction. No external data fetching or artificial delay.</li><li><strong>Async wait:</strong> one ${report.methodology.ioWaitMs} ms <code>setTimeout</code>, then ${report.methodology.renderedRows} cheap deterministic rows. This tests overlap, not network or storage performance. Cross-workload timing is not a like-for-like CPU comparison.</li><li>Both use canonical slash-ended URLs with <code>trailingSlash: 'always'</code>. Every page must have one request, one <code>200</code>, and zero redirects. The separate trailing-slash bug cannot inflate these concurrency measurements; the normal reproduction build still uses <code>trailingSlash: 'never'</code>.</li></ul>
<h2>Method and validation</h2><ul><li>${escape(report.methodology.warmup)}</li><li>${escape(report.methodology.isolation)}</li><li>${report.methodology.repeats} repeats at every condition. Forward/reverse paired orders: ${report.methodology.orders.map((order) => `<code>${order.join(" → ")}</code>`).join("; ")}.</li><li>${escape(report.methodology.logging)}</li><li>${escape(report.methodology.timing)}</li><li>${escape(report.methodology.outputCheck)}</li></ul>
<h2>Scope</h2><p>${escape(report.methodology.limits)} Synthetic CPU time can still change with JIT warmup, GC, filesystem I/O, host load, and queue overhead. Higher I/O concurrency can help without providing parallel JavaScript CPU execution; this experiment does not implement or time a worker pool.</p>
<details><summary>Machine, versions, and raw measurements</summary><p>${escape(report.system.cpu)} · ${report.system.logicalCpus} logical CPUs · ${(report.system.memoryBytes / 2 ** 30).toFixed(0)} GiB RAM · ${escape(report.system.platform)} ${escape(report.system.release)} ${escape(report.system.arch)} · Node ${escape(report.system.node)}</p><ul>${Object.entries(report.versions).map(([packageName, version]) => `<li><code>${escape(packageName)}</code> ${escape(version)}</li>`).join("")}</ul><p>Completed ${escape(report.completedAt)}. Lockfile SHA-256: <code>${report.lockfileSha256}</code>.</p><p>Reproduce with <code>npm ci</code>, then <code>npm run bench</code>. Experiment constants are in <code>benchmark/run.mjs</code>. This report embeds all ${report.runs.length} measured runs and ${report.warmups.length} warmups and uses no external assets.</p><pre>${escape(JSON.stringify(report, null, 2))}</pre></details>
<details><summary>All individual measured runs</summary><div class="scroll"><table><thead><tr><th>Workload</th><th>Pages</th><th>Concurrency</th><th>Repeat</th><th>Prerender (s)</th><th>Build (s)</th><th>CPU / wall</th><th>Peak HTTP</th></tr></thead><tbody>${report.runs.map((run) => `<tr><th>${run.workload}</th><td>${n(run.pageCount)}</td><td>${run.concurrency}</td><td>${run.repeat}</td><td>${seconds(run.prerenderMs)}</td><td>${seconds(run.buildMs)}</td><td>${(run.prerenderCpuMs / run.prerenderMs).toFixed(2)}</td><td>${run.peakActive}</td></tr>`).join("")}</tbody></table></div></details>
<p class="muted">Related: <a href="https://github.com/TanStack/router/issues/8483">concurrency issue #8483</a> · <a href="https://github.com/TanStack/router/issues/8850">separate redirect issue #8850</a>.</p>
</main><script>
let metric = 'prerenderMs';
const select = document.getElementById('case-select');
function updateViews() {
  document.querySelectorAll('[data-view-metric]').forEach(view => {
    view.hidden = view.dataset.case !== select.value || view.dataset.viewMetric !== metric;
  });
  document.querySelectorAll('[data-metric]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.metric === metric)));
}
select.addEventListener('change', updateViews);
document.querySelectorAll('[data-metric]').forEach(button => button.addEventListener('click', () => { metric = button.dataset.metric; updateViews(); }));
updateViews();
</script></body></html>`;
  await writeFile(path.join(directory, "report.html"), html);
  const csv = ["workload,pages,concurrency,repeat,prerender_ms,build_ms,prerender_cpu_ms,peak_active_http,requests", ...report.runs.map((run) => [run.workload, run.pageCount, run.concurrency, run.repeat, run.prerenderMs, run.buildMs, run.prerenderCpuMs, run.peakActive, run.requests].join(","))].join("\n") + "\n";
  await writeFile(path.join(directory, "results.csv"), csv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = new URL("./results/", import.meta.url);
  await renderReport(JSON.parse(await readFile(new URL("results.json", directory), "utf8")), fileURLToPath(directory));
}

