// Locates or fetches the Rudder binary for this platform. Shared by the npm
// launcher shim and the postinstall hook. Plain CommonJS so it runs under
// Node 18+ and Bun without a build step.
"use strict";

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const manifest = require(path.join(packageRoot, "package.json"));
const repository = "safzanpirani/rudder";

function platformTarget() {
  const goos = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const goarch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!goos || !goarch) return undefined;
  return { goos, goarch, extension: goos === "windows" ? ".exe" : "" };
}

function assetName(target) {
  return `rudder-${target.goos}-${target.goarch}${target.extension}`;
}

function binaryPath() {
  if (process.env.RUDDER_BINARY) return process.env.RUDDER_BINARY;
  const target = platformTarget();
  return path.join(packageRoot, `rudder${target ? target.extension : ""}`);
}

function readChecksums() {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, "checksums.json"), "utf8"));
  } catch {
    return {};
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function goAvailable() {
  const probe = spawnSync("go", ["version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

function buildFromSource(destination, log) {
  if (!fs.existsSync(path.join(packageRoot, "go.mod")) || !goAvailable()) return false;
  log(`rudder: building from source with go into ${destination}`);
  const result = spawnSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", destination, "."], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  return !result.error && result.status === 0 && fs.existsSync(destination);
}

async function download(url, destination, log) {
  log(`rudder: downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes, { mode: 0o755 });
}

/**
 * Returns the path of a usable binary, fetching or building one if needed.
 * Throws with actionable text when neither is possible.
 */
async function ensureBinary(options = {}) {
  const log = options.log || (() => undefined);
  const destination = binaryPath();
  if (fs.existsSync(destination)) return destination;
  if (process.env.RUDDER_BINARY)
    throw new Error(`RUDDER_BINARY points at ${destination}, which does not exist`);

  const target = platformTarget();
  const temporary = `${destination}.${process.pid}.tmp`;
  const checksums = readChecksums();
  const finish = () => {
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, destination);
    return destination;
  };

  if (target && process.env.RUDDER_SKIP_DOWNLOAD !== "1") {
    const asset = assetName(target);
    const expected = checksums[asset];
    const url = `https://github.com/${repository}/releases/download/v${manifest.version}/${asset}`;
    try {
      await download(url, temporary, log);
      const actual = sha256(temporary);
      if (expected && actual !== expected)
        throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
      if (!expected) log(`rudder: no pinned checksum for ${asset}; accepting download as-is`);
      return finish();
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing to clean up.
      }
      log(`rudder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (buildFromSource(temporary, log)) return finish();

  throw new Error(
    [
      `rudder: no prebuilt binary is available for ${os.platform()}/${os.arch()} at version ${manifest.version}.`,
      "Install Go 1.24 or newer and run `rudder` again to build from the bundled sources,",
      "or set RUDDER_BINARY to a binary built from https://github.com/safzanpirani/rudder.",
    ].join("\n"),
  );
}

module.exports = { assetName, binaryPath, ensureBinary, platformTarget, packageRoot };
