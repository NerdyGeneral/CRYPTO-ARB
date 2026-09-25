// Bundles tests/*.test.ts with esbuild and runs them with Node's built-in test runner.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = path.join(root, "dist-tests");
const entries = fs.readdirSync(path.join(root, "tests")).filter((file) => file.endsWith(".test.ts")).map((file) => path.join(root, "tests", file));
fs.rmSync(outDir, { recursive: true, force: true });
await build({ entryPoints: entries, outdir: outDir, bundle: true, platform: "node", target: "node22", format: "esm", outExtension: { ".js": ".mjs" }, logLevel: "warning" });
const files = fs.readdirSync(outDir).map((file) => path.join(outDir, file));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
