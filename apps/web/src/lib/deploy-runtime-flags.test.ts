import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./resolve-config";

/*
 * The feature flags the staging and production deploy workflows put on a revision (scripts/deploy/runtime-flags.mjs,
 * #84): every entry of its table against resolve-config.ts (what it needs is enough to start and turn the flag on;
 * what it needs is refused when missing), and the two workflows' use of it. Synthetic values only.
 */

interface Item {
  env: string;
  variable: string;
  stg?: string;
  shape?: string;
  optional?: boolean;
}
interface Flag {
  env: string;
  variable: string;
  defaults?: Partial<Record<Target, boolean>>;
  needs?: string[];
  secrets?: Item[];
  settings?: Item[];
  fixed?: Record<string, unknown>;
}
interface Resolved {
  problems: string[];
  on: string[];
  env: Record<string, string>;
  secrets: Record<string, string>;
  names: string[];
}
type Target = "stg" | "prod";
type Vars = Record<string, string>;

const repo = new URL("../../../../", import.meta.url);
const SCRIPT = fileURLToPath(new URL("scripts/deploy/runtime-flags.mjs", repo));
const { FLAGS, CAPABILITIES, resolveDeployFlags, outputsOf, tableNames } = await import(new URL("scripts/deploy/runtime-flags.mjs", repo).href) as {
  FLAGS: readonly Flag[];
  CAPABILITIES: readonly string[];
  resolveDeployFlags: (input: { target: Target; vars: Vars; hostConsole: boolean; siteUrl: string }) => Resolved;
  outputsOf: (resolved: Resolved) => Record<string, string>;
  tableNames: () => string[];
};

const SITE: Record<Target, string> = { stg: "https://niho-experience-host-stg-sample-an.a.run.app", prod: "https://experience.niho.life" };
const PREFIX: Record<Target, string> = { stg: "STG", prod: "PROD" };
const SETTING: Record<string, string> = {
  consentVersion: "sample-terms-2026-11",
  mailbox: "NIHO Sample <noreply@example.com>",
  httpsUrl: "https://example.com/privacy",
  vapidPublicKey: `B${"A".repeat(86)}`,
  vapidSubject: "mailto:ops@example.com",
};
const secretRef = (target: Target, item: Item) => (target === "stg" ? `${item.stg}:3` : `sample-${item.variable.toLowerCase().replaceAll("_", "-")}:2`);

/** Each flag's config setting: a new flag without one here fails "covers every flag". */
const CONFIG_KEY: Record<string, keyof ReturnType<typeof resolveConfig>> = {
  EXPERIENCE_GUEST_BOOKING_ENABLED: "guestBookingEnabled",
  EXPERIENCE_GUEST_MAIL_ENABLED: "guestMailEnabled",
  EXPERIENCE_GUEST_QUESTIONS_ENABLED: "guestQuestionsEnabled",
  EXPERIENCE_TRANSLATION_ENABLED: "translationEnabled",
  EXPERIENCE_GUEST_REVIEWS_ENABLED: "guestReviewsEnabled",
  EXPERIENCE_HOST_ATTENDANCE_ENABLED: "hostAttendanceEnabled",
  HOST_SALES_LEDGER_ENABLED: "hostSalesLedgerEnabled",
  HOST_SALES_PAYOUTS_ENABLED: "hostSalesPayoutsEnabled",
  HOST_NOTIFICATION_SETTINGS_ENABLED: "hostNotificationSettingsEnabled",
  HOST_PWA_ENABLED: "hostPwaEnabled",
  HOST_PUSH_ENABLED: "hostPushEnabled",
  EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED: "googleBusySyncEnabled",
  EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED: "googleBookingEventsEnabled",
};

const byEnv = new Map(FLAGS.map((flag) => [flag.env, flag]));

/** The flag's own variables: on, with every setting and Secret reference it takes. */
function varsOf(target: Target, flag: Flag): Vars {
  const name = (variable: string) => `${PREFIX[target]}_${variable}`;
  return {
    [name(flag.variable)]: "true",
    ...Object.fromEntries((flag.secrets ?? []).map((item) => [name(item.variable), secretRef(target, item)])),
    ...Object.fromEntries((flag.settings ?? []).map((item) => [name(item.variable), SETTING[item.shape!]!])),
  };
}

/** The flag and every flag it needs (the first of an "A|B"), each with its variables. */
function closure(target: Target, env: string, seen = new Set<string>()): Vars {
  if (seen.has(env)) return {};
  seen.add(env);
  const flag = byEnv.get(env)!;
  let vars = varsOf(target, flag);
  for (const need of flag.needs ?? []) {
    const first = need.split("|")[0]!;
    if (!CAPABILITIES.includes(first)) vars = { ...closure(target, first, seen), ...vars };
  }
  return vars;
}

/** What the workflow puts on the revision besides the table: the host console, its DB and Google client. */
const BASE = {
  EXPERIENCE_API_MODE: "http",
  HOST_CONSOLE_ENABLED: "true",
  BOOKINGS_ENABLED: "false",
  HOST_SESSION_SECRET: "s".repeat(32),
  NIHO_FIREBASE_WEB_API_KEY: "sample-firebase-key",
  EXPERIENCE_DATABASE_URL: "postgresql://sample@localhost/sample",
  EXPERIENCE_GOOGLE_CLIENT_ID: "sample-client",
  EXPERIENCE_GOOGLE_CLIENT_SECRET: "sample-secret",
  EXPERIENCE_GOOGLE_TOKEN_KEY: "c2FtcGxl",
};

/** What Secret Manager would give, where resolve-config checks its shape. */
const SECRET_VALUE: Record<string, string> = { EXPERIENCE_SMTP_HOST: "smtp.example.com", EXPERIENCE_SMTP_PORT: "587", HOST_PUSH_VAPID_PRIVATE_KEY: "A".repeat(43) };

/** The revision's environment: the base, the table's values, and a synthetic value for each Secret reference. */
function revision(target: Target, resolved: Resolved): Record<string, string> {
  return { ...BASE, SITE_URL: SITE[target], ...resolved.env, ...Object.fromEntries(Object.keys(resolved.secrets).map((name) => [name, SECRET_VALUE[name] ?? `synthetic-${name.toLowerCase()}`])) };
}

const resolve = (target: Target, vars: Vars, hostConsole = true) => resolveDeployFlags({ target, vars, hostConsole, siteUrl: SITE[target] });

describe("the deploy workflows' feature flags", () => {
  it("covers every flag of the table with a config setting", () => {
    expect(FLAGS.map((flag) => flag.env).sort()).toEqual(Object.keys(CONFIG_KEY).sort());
    expect(new Set(FLAGS.map((flag) => flag.variable)).size).toBe(FLAGS.length);
  });

  it("keeps everything off by default (staging keeps the app it always had)", () => {
    expect(resolve("prod", {})).toEqual({ problems: [], on: [], env: {}, secrets: {}, names: tableNames() });
    expect(resolve("stg", {})).toMatchObject({ problems: [], on: ["HOST_PWA_ENABLED"], env: { HOST_PWA_ENABLED: "true" }, secrets: {} });
    expect(resolve("stg", { STG_HOST_PWA_ENABLED: "false" })).toMatchObject({ problems: [], on: [], env: {} });
    // Variables of the other workflow are not read.
    expect(resolve("prod", { STG_GUEST_REVIEWS_ENABLED: "true" }).on).toEqual([]);
  });

  for (const target of ["stg", "prod"] as const) {
    it(`${target}: each flag with what it needs starts the server and turns on in resolve-config`, () => {
      for (const flag of FLAGS) {
        const resolved = resolve(target, closure(target, flag.env));
        expect(resolved.problems, flag.env).toEqual([]);
        expect(resolved.on, flag.env).toContain(flag.env);
        const config = resolveConfig(revision(target, resolved));
        expect(config[CONFIG_KEY[flag.env]!], flag.env).toBe(true);
      }
    });

    it(`${target}: everything on at once starts the server with every flag on`, () => {
      const vars = Object.assign({}, ...FLAGS.map((flag) => varsOf(target, flag))) as Vars;
      const resolved = resolve(target, vars);
      expect(resolved.problems).toEqual([]);
      expect(resolved.on).toEqual(FLAGS.map((flag) => flag.env));
      const config = resolveConfig(revision(target, resolved));
      for (const flag of FLAGS) expect(config[CONFIG_KEY[flag.env]!], flag.env).toBe(true);
      // The jobs are called by their own service accounts on the stable URL.
      expect(config.hostPushJobEnabled).toBe(true);
      expect(resolved.env).toMatchObject({
        EXPERIENCE_JOBS_AUDIENCE: SITE[target],
        EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL: `experience-jobs@niho-app-${target === "stg" ? "stg" : "prd"}.iam.gserviceaccount.com`,
        EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL: `experience-google-jobs@niho-app-${target === "stg" ? "stg" : "prd"}.iam.gserviceaccount.com`,
        HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL: `experience-host-push@niho-app-${target === "stg" ? "stg" : "prd"}.iam.gserviceaccount.com`,
      });
      // One reference for the platform key booking and payouts both use.
      expect(Object.keys(resolved.secrets).filter((name) => name === "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY")).toHaveLength(1);
      expect(Object.keys(resolved.env).every((name) => resolved.names.includes(name))).toBe(true);
      expect(Object.keys(resolved.secrets).every((name) => resolved.names.includes(name))).toBe(true);
    });

    it(`${target}: refuses a flag without a flag it needs, naming both`, () => {
      for (const flag of FLAGS) {
        for (const need of flag.needs ?? []) {
          if (CAPABILITIES.includes(need)) continue;
          const vars = { ...closure(target, flag.env) };
          for (const one of need.split("|")) vars[`${PREFIX[target]}_${byEnv.get(one)!.variable}`] = "false";
          const { problems } = resolve(target, vars);
          expect(problems.some((problem) => problem.includes(flag.env) && need.split("|").every((one) => problem.includes(one))), `${flag.env} needs ${need}`).toBe(true);
        }
      }
    });
  }

  it("production: every flag needs enable_host_calendar=true (the host console and its database)", () => {
    for (const flag of FLAGS) {
      const { problems } = resolve("prod", closure("prod", flag.env), false);
      expect(problems.some((problem) => problem.includes("enable_host_calendar=true")), flag.env).toBe(true);
    }
  });

  it("names a missing or malformed setting or Secret reference by its variable, never its value", () => {
    const booking = closure("stg", "EXPERIENCE_GUEST_BOOKING_ENABLED");
    const bad = {
      ...booking,
      STG_BOOKING_CONSENT_VERSION: "terms with spaces",
      STG_MAIL_FROM: "NIHO, Sample <noreply@example.com>",
      STG_STRIPE_PLATFORM_SECRET_KEY_REF: "SOME_OTHER_SECRET:1",
      STG_STRIPE_WEBHOOK_SECRET_REF: "experience-stg-stripe-webhook-secret:latest",
      STG_PRIVACY_POLICY_URL: "http://example.com/privacy",
    };
    const { problems } = resolve("stg", bad);
    for (const name of ["STG_BOOKING_CONSENT_VERSION", "STG_MAIL_FROM", "STG_STRIPE_PLATFORM_SECRET_KEY_REF", "STG_STRIPE_WEBHOOK_SECRET_REF", "STG_PRIVACY_POLICY_URL"]) {
      expect(problems.some((problem) => problem.includes(name)), name).toBe(true);
    }
    for (const value of ["terms with spaces", "NIHO, Sample", "SOME_OTHER_SECRET", ":latest", "http://example.com"]) expect(problems.join("\n")).not.toContain(value);
    // Production takes any Secret name with a numeric version, never latest.
    const prod = closure("prod", "HOST_SALES_PAYOUTS_ENABLED");
    expect(resolve("prod", { ...prod, PROD_STRIPE_PLATFORM_SECRET_KEY_REF: "any-platform-key:7" }).problems).toEqual([]);
    expect(resolve("prod", { ...prod, PROD_STRIPE_PLATFORM_SECRET_KEY_REF: "any-platform-key:latest" }).problems).toHaveLength(1);
    // The privacy URL is optional; a flag variable is true, false or unset.
    const withoutPrivacy = Object.fromEntries(Object.entries(booking).filter(([name]) => name !== "STG_PRIVACY_POLICY_URL"));
    expect(resolve("stg", withoutPrivacy).problems).toEqual([]);
    expect(resolve("stg", { STG_GUEST_REVIEWS_ENABLED: "TRUE" }).problems).toEqual(["STG_GUEST_REVIEWS_ENABLED must be true, false or unset"]);
  });

  it("writes --set-env-vars and --set-secrets without a comma inside a value", () => {
    const vars = Object.assign({}, ...FLAGS.map((flag) => varsOf("stg", flag))) as Vars;
    const resolved = resolve("stg", vars);
    const outputs = outputsOf(resolved);
    expect(outputs.env!.split(",")).toHaveLength(Object.keys(resolved.env).length);
    expect(outputs.secrets!.split(",")).toHaveLength(Object.keys(resolved.secrets).length);
    expect(outputs.env).toMatch(/^[A-Z][A-Z0-9_]*=[^,]+(,[A-Z][A-Z0-9_]*=[^,]+)*$/);
    expect(outputs.secrets).toMatch(/^[A-Z][A-Z0-9_]*=[A-Za-z0-9_-]+:[1-9][0-9]*(,[A-Z][A-Z0-9_]*=[A-Za-z0-9_-]+:[1-9][0-9]*)*$/);
    expect(JSON.parse(outputs.expected_env!)).toEqual(resolved.env);
    expect(JSON.parse(outputs.expected_secrets!)).toEqual(resolved.secrets);
    expect(outputsOf(resolve("prod", {}))).toEqual({ env: "", secrets: "", expected_env: "{}", expected_secrets: "{}", names: JSON.stringify(tableNames()), summary: "none" });
  });

  it("runs as the workflows run it: outputs to $GITHUB_OUTPUT, or every problem as an error and exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-flags-"));
    try {
      const output = join(dir, "output");
      const run = (vars: Vars, args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DEPLOY_VARS: JSON.stringify(vars), GITHUB_OUTPUT: output }, encoding: "utf8" });
      const ok = run({ PROD_GUEST_REVIEWS_ENABLED: "true", PROD_GCP_PROJECT_ID: "niho-app-prd" }, ["--target", "prod", "--host-console", "true", "--site-url", SITE.prod]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("Feature flags on: EXPERIENCE_GUEST_REVIEWS_ENABLED");
      const lines = readFileSync(output, "utf8").trim().split("\n");
      expect(lines.map((line) => line.slice(0, line.indexOf("=")))).toEqual(["env", "secrets", "expected_env", "expected_secrets", "names", "summary"]);
      expect(lines[0]).toBe("env=EXPERIENCE_GUEST_REVIEWS_ENABLED=true");
      const bad = run({ PROD_GUEST_BOOKING_ENABLED: "true", PROD_MAIL_FROM: "secret-looking@example.com" }, ["--target", "prod", "--host-console", "false", "--site-url", SITE.prod]);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toMatch(/^::error title=Deploy flags::EXPERIENCE_GUEST_BOOKING_ENABLED \(PROD_GUEST_BOOKING_ENABLED\) needs enable_host_calendar=true$/m);
      expect(bad.stdout).toContain("PROD_STRIPE_PLATFORM_SECRET_KEY_REF");
      expect(bad.stdout).not.toContain("secret-looking");
      expect(readFileSync(output, "utf8").trim().split("\n")).toHaveLength(6);
      expect(run({}, ["--target", "prod", "--host-console", "maybe", "--site-url", SITE.prod]).status).toBe(1);
      expect(run({}, ["--target", "stg", "--host-console", "true", "--site-url", "http://example.com"]).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the deploy workflows", () => {
  const workflow = (name: string) => readFileSync(new URL(`.github/workflows/${name}`, repo), "utf8");
  const WORKFLOWS = [
    { file: "deploy-production.yml", target: "prod", jobs: ["deploy", "promote"] },
    { file: "deploy-host-staging.yml", target: "stg", jobs: ["deploy"] },
  ] as const;

  /** A job's text, from its key to the next job. */
  function job(text: string, name: string): string {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(0);
    const next = text.slice(start + 1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  }

  for (const { file, target, jobs } of WORKFLOWS) {
    it(`${file} resolves the flags with the table before authenticating, and checks the revision with its names`, () => {
      const text = workflow(file);
      for (const name of jobs) {
        const body = job(text, name);
        const resolveAt = body.indexOf(`node scripts/deploy/runtime-flags.mjs --target ${target}`);
        expect(resolveAt, `${file} ${name}`).toBeGreaterThan(0);
        expect(body).toContain("DEPLOY_VARS: ${{ toJSON(vars) }}");
        expect(resolveAt, `${file} ${name}: before google-github-actions/auth`).toBeLessThan(body.indexOf("google-github-actions/auth@"));
        expect(body).toContain("steps.flags.outputs.expected_env");
        expect(body).toContain("steps.flags.outputs.expected_secrets");
      }
    });

    it(`${file} sets no flag of the table by hand`, () => {
      const text = workflow(file);
      for (const name of tableNames()) {
        expect(text, name).not.toMatch(new RegExp(`\\b${name}[=:]`));
      }
    });
  }
});
