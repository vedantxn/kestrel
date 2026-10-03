#!/usr/bin/env node
import { main } from "./main.js";

// Ctrl-C aborts the current call (or `logs --follow`) instead of killing the process mid-write.
const ac = new AbortController();
process.once("SIGINT", () => ac.abort());

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  signal: ac.signal,
});
