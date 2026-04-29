#!/usr/bin/env bun
/**
 * opencode バイナリ取得スクリプト
 *
 * scripts/opencode-binaries.lock.json に記録された URL から zip を取得し、
 * SHA256 を検証して bin/<arch>/opencode に展開する。
 *
 * 冪等: 既に正しい SHA256 のバイナリが配置済なら何もしない。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface BinaryEntry {
  url: string;
  sha256: string;
}

interface LockFile {
  version: string;
  binaries: Record<string, BinaryEntry>;
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const LOCK_PATH = resolve(REPO_ROOT, "scripts/opencode-binaries.lock.json");
const CACHE_DIR = resolve(REPO_ROOT, ".cache/opencode");
const BIN_DIR = resolve(REPO_ROOT, "bin");

function sha256(buffer: ArrayBuffer | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  return hash.digest("hex");
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return sha256(buf);
}

async function fetchBinary(arch: string, entry: BinaryEntry, version: string) {
  const archDir = resolve(BIN_DIR, arch);
  const binaryPath = resolve(archDir, "opencode");
  const zipCachePath = resolve(CACHE_DIR, `opencode-${version}-${arch}.zip`);

  if (existsSync(binaryPath)) {
    const existing = sha256File(binaryPath);
    const probe = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
    const versionOk = probe.status === 0 && probe.stdout.trim() === version;
    if (versionOk) {
      console.log(`[fetch-opencode] ${arch}: cached ${binaryPath} (sha256=${existing.slice(0, 12)}…) version=${version} OK, skipping`);
      return;
    }
    console.log(`[fetch-opencode] ${arch}: existing binary version mismatch or unverified, refetching`);
  }

  if (!existsSync(zipCachePath) || sha256File(zipCachePath) !== entry.sha256) {
    console.log(`[fetch-opencode] ${arch}: downloading ${entry.url}`);
    mkdirSync(dirname(zipCachePath), { recursive: true });
    const res = await fetch(entry.url);
    if (!res.ok) {
      throw new Error(`failed to download ${arch} zip: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    writeFileSync(zipCachePath, buf);
  }

  const actualZipSha = sha256File(zipCachePath);
  if (actualZipSha !== entry.sha256) {
    throw new Error(
      `[fetch-opencode] ${arch}: SHA256 mismatch.\n  expected: ${entry.sha256}\n  actual:   ${actualZipSha}`
    );
  }
  console.log(`[fetch-opencode] ${arch}: zip SHA256 verified (${actualZipSha.slice(0, 12)}…)`);

  mkdirSync(archDir, { recursive: true });
  const unzip = spawnSync("unzip", ["-o", zipCachePath, "-d", archDir], { encoding: "utf8" });
  if (unzip.status !== 0) {
    throw new Error(`[fetch-opencode] ${arch}: unzip failed: ${unzip.stderr}`);
  }

  const chmod = spawnSync("chmod", ["755", binaryPath]);
  if (chmod.status !== 0) {
    throw new Error(`[fetch-opencode] ${arch}: chmod 755 failed`);
  }

  spawnSync("xattr", ["-d", "com.apple.quarantine", binaryPath], { encoding: "utf8" });

  const probe = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== version) {
    throw new Error(
      `[fetch-opencode] ${arch}: --version mismatch. expected=${version} got=${probe.stdout.trim()}`
    );
  }
  console.log(`[fetch-opencode] ${arch}: installed ${binaryPath} (--version=${version})`);
}

async function main() {
  if (!existsSync(LOCK_PATH)) {
    throw new Error(`lock file not found: ${LOCK_PATH}`);
  }
  const lock: LockFile = JSON.parse(readFileSync(LOCK_PATH, "utf8"));

  const archs = Object.keys(lock.binaries);
  for (const arch of archs) {
    await fetchBinary(arch, lock.binaries[arch]!, lock.version);
  }
  console.log(`[fetch-opencode] all binaries ready (version ${lock.version})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
