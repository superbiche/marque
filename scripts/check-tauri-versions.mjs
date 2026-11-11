#!/usr/bin/env node
// Fail when a Tauri crate and its npm package disagree on major.minor.
// `tauri build` refuses such a mismatch, but only at bundle time; this check
// runs in CI on every pull request so the mismatch never reaches a release tag.
// Pairs: `tauri` <-> `@tauri-apps/api`, `tauri-plugin-<x>` <-> `@tauri-apps/plugin-<x>`.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function lockedCrates() {
  const lock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const crates = new Map();
  for (const block of lock.split("[[package]]")) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (name && version) {
      if (!crates.has(name)) crates.set(name, new Set());
      crates.get(name).add(version);
    }
  }
  return crates;
}

function installedNpmVersion(pkg) {
  const manifest = join(root, "node_modules", ...pkg.split("/"), "package.json");
  if (!existsSync(manifest)) return null;
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

const majorMinor = (v) => v.split(".").slice(0, 2).join(".");

const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npmPackages = Object.keys({ ...declared.dependencies, ...declared.devDependencies }).filter(
  (name) => name === "@tauri-apps/api" || name.startsWith("@tauri-apps/plugin-"),
);

const crates = lockedCrates();
const problems = [];
for (const pkg of npmPackages) {
  const crate = pkg === "@tauri-apps/api" ? "tauri" : `tauri-plugin-${pkg.slice("@tauri-apps/plugin-".length)}`;
  const npmVersion = installedNpmVersion(pkg);
  const crateVersions = crates.get(crate);
  if (!npmVersion) {
    problems.push(`${pkg}: not installed (run pnpm install --frozen-lockfile first)`);
    continue;
  }
  if (!crateVersions) {
    problems.push(`${pkg} ${npmVersion}: no ${crate} crate in Cargo.lock`);
    continue;
  }
  for (const crateVersion of crateVersions) {
    const ok = majorMinor(crateVersion) === majorMinor(npmVersion);
    console.log(`${ok ? "ok  " : "FAIL"} ${crate} ${crateVersion} <-> ${pkg} ${npmVersion}`);
    if (!ok) problems.push(`${crate} ${crateVersion} vs ${pkg} ${npmVersion}`);
  }
}

if (problems.length) {
  console.error("\nTauri crate/npm version mismatch (major.minor must match):");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
