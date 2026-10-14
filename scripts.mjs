import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const mode = process.argv[2] ?? "build";
const dist = "dist";

async function copyAssets() {
  await mkdir(dist, { recursive: true });
  await cp("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", `${dist}/pdf.worker.min.mjs`);
  await cp("node_modules/pdfjs-dist/web/pdf_viewer.css", `${dist}/pdf_viewer.css`);
  await cp("media/webview.css", `${dist}/webview.css`);
}

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: `${dist}/extension.js`,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info"
};

const webviewOptions = {
  entryPoints: ["src/webview.ts"],
  bundle: true,
  outfile: `${dist}/webview.js`,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info"
};

if (mode === "clean") {
  if (existsSync(dist)) {
    await rm(dist, { recursive: true, force: true });
  }
  process.exit(0);
}

await rm(dist, { recursive: true, force: true });
await copyAssets();

if (mode === "watch") {
  const extensionContext = await esbuild.context(extensionOptions);
  const webviewContext = await esbuild.context(webviewOptions);
  await extensionContext.watch();
  await webviewContext.watch();
  console.log("Watching extension and webview sources...");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions)
  ]);
}
