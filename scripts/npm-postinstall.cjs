// Fetches the platform binary at install time so the first `rudder` call is
// instant. Failures only warn: the launcher retries on first use.
"use strict";

const { spawnSync } = require("node:child_process");
const { ensureBinary } = require("./npm-binary.cjs");

const log = (message) => process.stderr.write(`${message}\n`);

ensureBinary({ log })
  .then((binary) => {
    log(`rudder: installed binary at ${binary}`);
    const bun = spawnSync("bun", ["--version"], { stdio: "ignore" });
    if (bun.error || bun.status !== 0)
      log("rudder: Bun 1.4 or newer is required for `rudder tui` and the Claude, OpenCode, and Pi providers: https://bun.sh");
  })
  .catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    log("rudder: the binary will be fetched again the first time you run `rudder`.");
  });
