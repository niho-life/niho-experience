import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

/*
 * 運営の CLI (#576, docs/operator-cli.md): the parts every target shares. The CLI calls the same /admin/api routes the
 * Admin screens use (nothing else writes), with the operator's own Google ID token. It never prints a token, and what it
 * prints is JSON.
 *
 * Node runs this directly (type stripping): erasable TypeScript only, `.ts` in import paths.
 */

export type Tier = "read" | "edit" | "publish" | "terms";
export type AiKind = "claude-code" | "codex" | "other" | "human";
export const AI_KINDS: readonly AiKind[] = ["claude-code", "codex", "other", "human"];
export type EnvName = "stg" | "prd";

export const ENV_ORIGINS: Readonly<Record<EnvName, string>> = Object.freeze({
  stg: "https://experience-stg.niho.life",
  prd: "https://experience.niho.life",
});
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** Exit codes: 0 done (or a dry run), 1 refused or failed, 2 bad usage, 3 not signed in, 4 conflict (changed meanwhile). */
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, auth: 3, conflict: 4 });

export class OpsError extends Error {
  readonly code: string;
  readonly exit: number;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, exit: number = EXIT.failed, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "OpsError";
    this.code = code;
    this.exit = exit;
    this.detail = detail;
  }
}

export interface Args {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "help", "unclassified", "listed", "unlisted", "photo-rights-confirmed", "consent-confirmed", "rights-confirmed", "again"]);
const VALUE_FLAGS = new Set(["env", "file", "ai", "id", "slug", "status", "provider", "product", "seller-confirmation", "occurrence", "subject", "assignee", "due", "note", "kind", "name", "from", "to", "alt", "alt-ja", "photographer", "permission", "credit", "reason"]);

/** `--name value`, `--name=value` and the boolean flags `--dry-run`, `--yes`; everything else is positional. */
export function parseArgs(argv: readonly string[], valueFlags: ReadonlySet<string> = VALUE_FLAGS): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) throw new OpsError("usage", `--${name} takes no value.`, EXIT.usage);
      flags[name] = true;
    } else if (valueFlags.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) throw new OpsError("usage", `--${name} needs a value.`, EXIT.usage);
      flags[name] = value;
    } else {
      throw new OpsError("usage", `Unknown option --${name}.`, EXIT.usage);
    }
  }
  return { positional, flags };
}

export function resolveEnv(flags: Args["flags"], environment: Readonly<Record<string, string | undefined>>): { name: EnvName; origin: string } {
  const name = flags.env === undefined ? "stg" : flags.env;
  if (name !== "stg" && name !== "prd") throw new OpsError("usage", "--env must be stg or prd.", EXIT.usage);
  const override = environment.NIHO_OPS_BASE_URL;
  if (override) {
    // The token goes to this origin, so only this machine may be named instead of the two sites.
    if (!LOCAL_ORIGIN.test(override)) throw new OpsError("usage", "NIHO_OPS_BASE_URL may only name http://localhost or http://127.0.0.1.", EXIT.usage);
    return { name, origin: override };
  }
  return { name, origin: ENV_ORIGINS[name] };
}

/** Who the caller works for: --ai, NIHO_OPS_AI, then the AI tool's own environment, else a person at a terminal. */
export function resolveAiKind(flags: Args["flags"], environment: Readonly<Record<string, string | undefined>>): AiKind {
  const named = flags.ai !== undefined ? flags.ai : environment.NIHO_OPS_AI;
  if (named !== undefined) {
    if (!(AI_KINDS as readonly string[]).includes(named as string)) throw new OpsError("usage", `--ai must be one of ${AI_KINDS.join(", ")}.`, EXIT.usage);
    return named as AiKind;
  }
  if (environment.CLAUDECODE) return "claude-code";
  if (Object.keys(environment).some((key) => key.startsWith("CODEX_"))) return "codex";
  return "human";
}

const JWT = /^[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}$/;

/** The token's expiry (ms), or null for a value that is not a JWT. The claims are not trusted; the server checks them. */
export function tokenExpiry(token: string): number | null {
  if (!JWT.test(token)) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export type TokenSource = (environment: Readonly<Record<string, string | undefined>>) => string;

/** NIHO_OPS_ID_TOKEN, else `gcloud auth print-identity-token` (NIHO_OPS_ACCOUNT picks the account). Never printed. */
export const gcloudTokenSource: TokenSource = (environment) => {
  if (environment.NIHO_OPS_ID_TOKEN) return environment.NIHO_OPS_ID_TOKEN.trim();
  const account = environment.NIHO_OPS_ACCOUNT?.trim();
  const run = spawnSync("gcloud", ["auth", "print-identity-token", ...(account ? [`--account=${account}`] : [])], { encoding: "utf8", timeout: 60_000 });
  if (run.error || run.status !== 0 || !run.stdout.trim()) {
    throw new OpsError("no_id_token", "No Google ID token: run `gcloud auth login <you>@niho.life` (and NIHO_OPS_ACCOUNT=<you>@niho.life if another account is active), or set NIHO_OPS_ID_TOKEN.", EXIT.auth);
  }
  return run.stdout.trim();
};

export interface Api {
  readonly env: EnvName;
  readonly aiKind: AiKind;
  get(path: string): Promise<ApiResponse>;
  /** A change: `operationId` is the caller's ID for this one operation (the server refuses a repeat). */
  send(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown, operationId: string, raw?: RawBody): Promise<ApiResponse>;
}

/** A body that is not JSON (a photo): its bytes and content type, and the headers the route reads. */
export interface RawBody {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface Context {
  readonly api: Api;
  readonly args: Args;
  /** `--yes`: apply. Without it a change is only planned (a dry run). */
  readonly apply: boolean;
  readonly env: EnvName;
  readonly readFile: (path: string) => string;
  readonly readBytes: (path: string) => Uint8Array;
  readonly now: () => number;
}

export interface ApiOptions {
  readonly env: { name: EnvName; origin: string };
  readonly aiKind: AiKind;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly tokenSource?: TokenSource;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function createApi(options: ApiOptions): Api {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let token: string | null = null;
  const authorization = (): string => {
    if (token === null) {
      const value = (options.tokenSource ?? gcloudTokenSource)(options.environment);
      const expiry = tokenExpiry(value);
      if (expiry === null) throw new OpsError("no_id_token", "The Google ID token is not a JWT.", EXIT.auth);
      if (expiry <= now() + 30_000) throw new OpsError("token_expired", "The Google ID token has expired: run the command again (gcloud prints a new one).", EXIT.auth);
      token = value;
    }
    return `Bearer ${token}`;
  };
  async function call(method: string, path: string, body: unknown, operationId: string | null, raw?: RawBody): Promise<ApiResponse> {
    if (!path.startsWith("/admin/api/")) throw new OpsError("usage", "Only /admin/api paths are called.", EXIT.usage);
    const headers: Record<string, string> = { authorization: authorization(), "x-niho-operator-ai": options.aiKind, accept: "application/json", "user-agent": "niho-ops-cli/1" };
    if (operationId) headers["x-niho-operation-id"] = operationId;
    if (raw) Object.assign(headers, raw.headers, { "content-type": raw.contentType });
    else if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(`${options.env.origin}${path}`, { method, headers, body: raw ? raw.bytes as BodyInit : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error" });
    } catch {
      throw new OpsError("unreachable", `${options.env.name} did not answer.`, EXIT.failed);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed };
  }
  return {
    env: options.env.name,
    aiKind: options.aiKind,
    get: (path) => call("GET", path, undefined, null),
    send: (method, path, body, operationId, raw) => call(method, path, body, operationId, raw),
  };
}

/** The code of a refusal: `{ error: "code" }` or the product API's `{ error: { code: "CODE" } }` (lower-cased). */
export function errorCode(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code.toLowerCase() : "request_failed";
}

/** The server's answer as an error: 401/403 are "not signed in / not allowed", 409 a change meanwhile. */
export function failureOf(response: ApiResponse, action: string): OpsError {
  const code = errorCode(response.body);
  const blockers = ((response.body as { error?: { blockers?: unknown } } | null)?.error)?.blockers;
  const detail = { status: response.status, ...(Array.isArray(blockers) ? { blockers } : {}) };
  if (response.status === 401) return new OpsError(code, "Not signed in: the Google ID token was refused (expired, another client, or not a niho.life account).", EXIT.auth, detail);
  if (response.status === 403) return new OpsError(code, code === "not_available_from_cli" ? "This is not available from the CLI." : "This account is not on the Admin allowlist, or the CLI is not open on this site.", EXIT.auth, detail);
  if (response.status === 404) return new OpsError(code, `${action}: not found, or this feature is not open on this site.`, EXIT.failed, detail);
  if (response.status === 409 || response.status === 412) return new OpsError(code, `${action}: it changed meanwhile (${code}). Read it again and re-plan.`, EXIT.conflict, detail);
  return new OpsError(code, `${action} failed (${response.status}, ${code}).`, EXIT.failed, detail);
}

export interface Change {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What differs between two JSON values, one entry per leaf path (arrays count as one leaf each). */
export function diffValues(before: unknown, after: unknown, path = ""): Change[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => diffValues(before[key], after[key], path ? `${path}.${key}` : key));
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? [] : [{ path: path || "(value)", before: before ?? null, after: after ?? null }];
}

/**
 * An operation ID for one change. The first attempt's is stable (the same file and item give the same ID), so a run whose
 * answer was lost, started again, is recognised by the server as the same operation; a retry after that adds `-r<random>`,
 * so a try that failed (and used up its ID) never blocks the next one.
 */
export function operationId(parts: readonly string[], attempt: number, now: number, random: () => string = () => randomBytes(3).toString("hex")): string {
  const date = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
  return `op-${date}-${digest}${attempt > 1 ? `-r${random()}` : ""}`;
}

export type WriteStatus = "unchanged" | "dry_run" | "applied" | "failed";
export interface WriteResult {
  readonly key: string;
  readonly status: WriteStatus;
  readonly changes: readonly Change[];
  readonly error?: string;
}

export interface WriteSpec<State> {
  /** What this item is called in the result and in its operation ID. */
  readonly key: string;
  /** Reads the current state (the "before"); called again after a refused repeat. */
  readonly read: () => Promise<State>;
  /** The state wanted. */
  readonly desired: (current: State) => State;
  /** Sends the change; `current` is what was read (for its revision). */
  readonly send: (current: State, desired: State, operationId: string) => Promise<ApiResponse>;
}

/**
 * Reads, diffs, and (with --yes) applies one change. No difference means nothing is sent, so running a file again does
 * not change anything twice. A repeat of an operation ID the server already recorded is not an error: the state is read
 * again and the change retried under a new ID only if it is still not in place.
 */
export async function writeOne<State>(context: Context, seed: readonly string[], spec: WriteSpec<State>): Promise<WriteResult> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await spec.read();
    const desired = spec.desired(current);
    const changes = diffValues(current, desired);
    if (changes.length === 0) return { key: spec.key, status: "unchanged", changes };
    if (!context.apply) return { key: spec.key, status: "dry_run", changes };
    const response = await spec.send(current, desired, operationId([...seed, spec.key], attempt, context.now()));
    if (response.status >= 200 && response.status < 300) return { key: spec.key, status: "applied", changes };
    const error = failureOf(response, spec.key);
    if (error.code === "operation_already_recorded") continue;
    return { key: spec.key, status: "failed", changes, error: error.code };
  }
  return { key: spec.key, status: "failed", changes: [], error: "operation_already_recorded" };
}

/**
 * Sends one change whose result cannot be diffed (a create, a publish): under a stable operation ID first, and, when the server
 * says it already recorded that ID, `alreadyDone` looks at the current state; if the change is in place it is returned, otherwise
 * the send is retried under a fresh ID (a try that failed has used up its own). Returns the response, or `alreadyDone`'s value.
 */
export async function sendOnce<Done>(context: Context, seed: readonly string[], send: (operationId: string) => Promise<ApiResponse>, alreadyDone: () => Promise<Done | null>): Promise<{ readonly response: ApiResponse } | { readonly done: Done }> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await send(operationId(seed, attempt, context.now()));
    if (!(response.status === 409 && errorCode(response.body) === "operation_already_recorded")) return { response };
    const done = await alreadyDone();
    if (done !== null) return { done };
  }
  throw new OpsError("operation_already_recorded", "The server kept refusing the operation ID; read the state and run it again.", EXIT.failed);
}

export interface Action {
  readonly tier: Tier;
  readonly summary: string;
  readonly run: (context: Context) => Promise<unknown>;
}
export interface Target {
  readonly summary: string;
  readonly actions: Readonly<Record<string, Action>>;
}

export function redactable(value: string): string {
  return value.replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[token]");
}
