#!/usr/bin/env node
import { runMcpStdio } from "../src/mcp-stdio.mjs";

const index = process.argv.indexOf("--socket");
if (index < 0 || index !== process.argv.length - 2) process.exit(2);
runMcpStdio({ socketPath: process.argv[index + 1] }).catch(() => { process.exitCode = 2; });
