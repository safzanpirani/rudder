#!/usr/bin/env node
// npm launcher: runs the native Ruddr binary that lives beside the TUI and
// adapter sources in this package, so the binary's sibling lookup finds them.
"use strict";

const { spawnSync } = require("node:child_process");
const { ensureBinary } = require("../scripts/npm-binary.cjs");

ensureBinary({ log: (message) => process.stderr.write(`${message}\n`) })
  .then((binary) => {
    const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exit(result.status ?? 1);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
