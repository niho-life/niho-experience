import { readFileSync } from "node:fs";
import { EXIT, OpsError, createApi, parseArgs, redactable, resolveAiKind, resolveEnv, type Api, type Context, type Target, type TokenSource } from "./core.ts";
import { authTarget } from "./auth.ts";

/**
 * Every target the CLI knows. A stage adds its own here (classification, people, product, guide, inquiry); the
 * /admin/api areas the server opens to the CLI are the same list (apps/web/src/lib/admin/operator-cli.ts).
 */
export const TARGETS: Readonly<Record<string, Target>> = Object.freeze({
  auth: authTarget,
});

export interface Runtime {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly tokenSource?: TokenSource;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly readFile?: (path: string) => string;
  readonly api?: Api;
  readonly targets?: Readonly<Record<string, Target>>;
}

export const USAGE = [
  "node scripts/experience/ops.mjs <target> <action> [--file change.json] [--dry-run | --yes] [--env stg|prd] [--ai claude-code|codex|other|human]",
  "  Default environment is stg; production only with --env prd. A change is planned (a dry run) unless --yes is given.",
  "  Output is JSON. Exit codes: 0 done or planned, 1 refused or failed, 2 usage, 3 not signed in, 4 changed meanwhile.",
  "  node scripts/experience/ops.mjs help          lists the targets and actions",
].join("\n");

export interface Outcome {
  readonly exit: number;
  readonly output: unknown;
}

function help(targets: Readonly<Record<string, Target>>): unknown {
  return {
    usage: USAGE,
    targets: Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, { summary: target.summary, actions: Object.fromEntries(Object.entries(target.actions).map(([action, spec]) => [action, { tier: spec.tier, summary: spec.summary }])) }])),
  };
}

/** Runs one command line. Never throws: an error is an Outcome with the exit code and a JSON body. */
export async function run(argv: readonly string[], runtime: Runtime): Promise<Outcome> {
  const targets = runtime.targets ?? TARGETS;
  try {
    const args = parseArgs(argv);
    const [targetName, actionName] = args.positional;
    if (args.flags.help || targetName === undefined || targetName === "help") return { exit: EXIT.ok, output: help(targets) };
    const target = targets[targetName];
    const action = target && actionName !== undefined ? target.actions[actionName] : undefined;
    if (!target || !action) throw new OpsError("usage", `Unknown command: ${targetName}${actionName ? ` ${actionName}` : ""}. Run \`help\`.`, EXIT.usage);
    if (args.flags["dry-run"] && args.flags.yes) throw new OpsError("usage", "--dry-run and --yes cannot be used together.", EXIT.usage);
    const env = resolveEnv(args.flags, runtime.environment);
    const aiKind = resolveAiKind(args.flags, runtime.environment);
    const api = runtime.api ?? createApi({ env, aiKind, environment: runtime.environment, tokenSource: runtime.tokenSource, fetch: runtime.fetch, now: runtime.now });
    const context: Context = {
      api, args, env: env.name, now: runtime.now ?? Date.now,
      apply: action.tier !== "read" && args.flags.yes === true,
      readFile: runtime.readFile ?? ((path) => readFileSync(path, "utf8")),
    };
    const result = await action.run(context);
    const mode = action.tier === "read" ? "read" : context.apply ? "apply" : "dry-run";
    return { exit: EXIT.ok, output: { ok: true, env: env.name, target: targetName, action: actionName, tier: action.tier, mode, result } };
  } catch (error) {
    if (error instanceof OpsError) return { exit: error.exit, output: { ok: false, error: error.code, message: redactable(error.message), ...error.detail } };
    return { exit: EXIT.failed, output: { ok: false, error: "unexpected", message: redactable(error instanceof Error ? error.message : "unexpected error") } };
  }
}
