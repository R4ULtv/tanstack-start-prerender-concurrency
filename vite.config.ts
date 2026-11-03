import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

// Edit constants here for a single reproduction build. No environment variables.
const PAGE_COUNT = 1000;
const CONCURRENCY = 1;

export default defineConfig({
  define: {
    __PRERENDER_WORKLOAD__: JSON.stringify("cpu"),
    __PRERENDER_TRAILING_SLASH__: JSON.stringify("never"),
  },
  plugins: [
    tanstackStart({
      pages: Array.from({ length: PAGE_COUNT }, (_, i) => ({ path: `/page/${i}` })),
      prerender: {
        enabled: true,
        concurrency: CONCURRENCY,
        crawlLinks: false,
        autoStaticPathsDiscovery: false,
        failOnError: true,
      },
    }),
    viteReact(),
  ],
});
