#!/usr/bin/env bun

import { createEmitter, runAppServer } from "../adapter/protocol";
import { OpenCodeRuddrAdapter } from "./runtime";

const emit = createEmitter();
await runAppServer(new OpenCodeRuddrAdapter(emit), emit);
