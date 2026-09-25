// Bundles the background paper engine and packages it as a single executable using Node's
// single-executable-application (SEA) support: the bundle is injected into an official Node binary.
//
//   node scripts/build-exe.mjs --bundle-only     -> dist-engine/engine.cjs (run with `node`)
//   node scripts/build-exe.mjs --target win-x64  -> release/ArbiterPaper.exe (default)
//   node scripts/build-exe.mjs --target host     -> an executable for this machine, for local testing
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postject from "postject";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const hostTarget = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const requested = option("--target", "win-x64");
const target = requested === "host" ? hostTarget : requested;
const outDir = path.join(root, "dist-engine");
const releaseDir = path.join(root, "release");

fs.mkdirSync(outDir, { recursive: true });
const bundle = path.join(outDir, "engine.cjs");
await build({
  entryPoints: [path.join(root, "engine/main.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  loader: { ".html": "text" },
  legalComments: "none",
  logLevel: "warning",
});
console.log(`Bundled engine: ${path.relative(root, bundle)}`);
if (args.includes("--bundle-only")) process.exit(0);

if (!["win-x64", "linux-x64", hostTarget].includes(target)) throw new Error(`Unsupported target ${target}. Use win-x64, linux-x64 or host.`);
if (target.startsWith("darwin")) throw new Error("macOS executables need code signing; run the engine with `pnpm engine` instead.");

// The blob is platform independent because code cache and snapshots are off.
const seaConfig = path.join(outDir, "sea-config.json");
const blob = path.join(outDir, "sea-prep.blob");
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// Use the same Node version that produced the blob. A matching host binary is copied; otherwise
// the official build is downloaded from nodejs.org and checked against its published SHA-256.
async function nodeBinary() {
  if (target === hostTarget) return process.execPath;
  const version = `v${process.versions.node}`;
  const remote = target === "win-x64" ? "win-x64/node.exe" : null;
  if (!remote) throw new Error(`Cross-building ${target} is not supported; build on that platform with --target host.`);
  const cached = path.join(root, ".cache", "node", version, remote);
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((line) => line.trim().endsWith(` ${remote}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`No checksum for ${remote} in Node ${version}`);
  const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (!fs.existsSync(cached) || sha(cached) !== expected) {
    console.log(`Downloading Node ${version} ${remote}…`);
    const response = await fetch(`https://nodejs.org/dist/${version}/${remote}`);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
    if (sha(cached) !== expected) { fs.rmSync(cached); throw new Error("Downloaded Node binary failed its checksum"); }
  }
  return cached;
}

// Injecting the bundle invalidates node.exe's Authenticode signature, and Windows treats a broken
// signature more harshly than none, so drop the certificate table first (as `signtool remove` would).
function stripWindowsSignature(file) {
  const exe = fs.readFileSync(file);
  const optionalHeader = exe.readUInt32LE(0x3c) + 24;
  if (exe.readUInt16LE(optionalHeader) !== 0x20b) throw new Error("Expected a 64-bit Windows executable");
  const securityEntry = optionalHeader + 112 + 4 * 8;
  const offset = exe.readUInt32LE(securityEntry), size = exe.readUInt32LE(securityEntry + 4);
  if (!size) return;
  if (offset + size !== exe.length) throw new Error("Unexpected signature layout in node.exe");
  exe.writeUInt32LE(0, securityEntry);
  exe.writeUInt32LE(0, securityEntry + 4);
  fs.writeFileSync(file, exe.subarray(0, offset));
}

fs.mkdirSync(releaseDir, { recursive: true });
const output = path.join(releaseDir, target.startsWith("win") ? "ArbiterPaper.exe" : "arbiter-paper");
fs.copyFileSync(await nodeBinary(), output);
fs.chmodSync(output, 0o755);
if (target.startsWith("win")) stripWindowsSignature(output);
await postject.inject(output, "NODE_SEA_BLOB", fs.readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  overwrite: true,
});
console.log(`Packaged ${target}: ${path.relative(root, output)} (${(fs.statSync(output).size / 1048576).toFixed(1)} MB)`);
