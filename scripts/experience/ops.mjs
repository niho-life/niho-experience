#!/usr/bin/env node
// 運営の CLI (#576): the Admin screens' operations from a command line, for people and for AI (Claude Code, Codex).
// It calls the same /admin/api routes as the screens with your own Google ID token (`gcloud auth print-identity-token`);
// it never writes to a database. Read docs/operator-cli.md first.
//
//   node scripts/experience/ops.mjs help
//   node scripts/experience/ops.mjs auth check [--env stg|prd]
import { run } from "./ops/main.ts";

const outcome = await run(process.argv.slice(2), { environment: process.env });
console.log(JSON.stringify(outcome.output, null, 2));
process.exitCode = outcome.exit;
