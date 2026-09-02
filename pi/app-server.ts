#!/usr/bin/env bun

import { createEmitter, runAppServer } from "../adapter/protocol";
import { PiRuddrAdapter } from "./runtime";

const emit = createEmitter();
await runAppServer(new PiRuddrAdapter(emit), emit);
