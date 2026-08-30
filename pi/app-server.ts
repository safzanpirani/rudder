#!/usr/bin/env bun

import { createEmitter, runAppServer } from "../adapter/protocol";
import { PiRudderAdapter } from "./runtime";

const emit = createEmitter();
await runAppServer(new PiRudderAdapter(emit), emit);
