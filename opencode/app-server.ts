#!/usr/bin/env bun

import { createEmitter, runAppServer } from "../adapter/protocol";
import { OpenCodeRudderAdapter } from "./runtime";

const emit = createEmitter();
await runAppServer(new OpenCodeRudderAdapter(emit), emit);
