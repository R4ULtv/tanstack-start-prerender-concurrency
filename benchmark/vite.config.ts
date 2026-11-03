import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const settings = JSON.parse(readFileSync(new URL("./.run.json", import.meta.url), "utf8")) as {
  pageCount: number;
  concurrency: number;
  workload: "cpu" | "io";
  metricsFile: string;
};
const paths = Array.from({ length: settings.pageCount }, (_, id) => `/page/${id}/`);

const observePreview: Plugin = {
  name: "benchmark-observe-preview",
  apply: (_config, { isPreview }) => !!isPreview,
  configurePreviewServer: {
    order: "pre",
    handler(server) {
      const requests = new Map<string, number>();
      const responses: Record<string, number> = {};
      let active = 0;
      let peakActive = 0;
      server.middlewares.use((req, res, next) => {
        const url = req.originalUrl ?? req.url ?? "/";
        requests.set(url, (requests.get(url) ?? 0) + 1);
        peakActive = Math.max(peakActive, ++active);
        res.once("finish", () => {
          active--;
          const status = String(res.statusCode);
          responses[status] = (responses[status] ?? 0) + 1;
        });
        next();
      });
      server.httpServer?.once("close", () => {
        writeFileSync(settings.metricsFile, JSON.stringify({
          requests: [...requests.values()].reduce((sum, count) => sum + count, 0),
          responses,
          peakActive,
          activeAtClose: active,
          exactRequestPaths: requests.size === paths.length && paths.every((url) => requests.get(url) === 1),
        }));
      });
    },
  },
};

export default defineConfig({
  define: {
    __PRERENDER_WORKLOAD__: JSON.stringify(settings.workload),
    // Isolate concurrency from the separate forced-trailing-slash redirect bug.
    // The benchmark requests canonical slash-ended URLs; it rewrites nothing.
    __PRERENDER_TRAILING_SLASH__: JSON.stringify("always"),
  },
  plugins: [
    observePreview,
    tanstackStart({
      pages: paths.map((path) => ({ path })),
      prerender: {
        enabled: true,
        concurrency: settings.concurrency,
        crawlLinks: false,
        autoStaticPathsDiscovery: false,
        autoSubfolderIndex: true,
        failOnError: true,
      },
    }),
    viteReact(),
  ],
});
