#!/usr/bin/env node
import { main } from './cli.ts';

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
