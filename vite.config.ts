// Bundles each UI view (HTML + TS + CSS) into one self-contained HTML file.
// The host loads a UI resource as a single document, so everything must be inline.
// Run once per view because vite-plugin-singlefile supports one input per build.
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import pkg from "./package.json" with { type: "json" };

const view = process.env.VIEW ?? "rewards";

export default defineConfig({
  root: "ui",
  plugins: [viteSingleFile()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: "../dist", emptyOutDir: false, rollupOptions: { input: `ui/${view}.html` } },
});
