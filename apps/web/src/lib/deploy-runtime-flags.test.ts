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
  value?: string;
  defaults?: Partial<Record<Target, boolean>>;
  needs?: string[];
  conflicts?: string[];
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
const NIHO_API_AUDIENCE: Record<Target, string> = { stg: "https://api-stg.niho.life", prod: "https://api.niho.life" };
const SETTING: Record<string, string> = {
  consentVersion: "sample-terms-2026-11",
  bucketName: "experience-test-public-media",
  mailbox: "NIHO Sample <noreply@example.com>",
  httpsUrl: "https://example.com/privacy",
  httpsOrigin: "https://editor.example.com",
  cloudRunServiceUrl: "https://niho-experience-sample-an.a.run.app",
  serviceAccountList: "caller@sample-project.iam.gserviceaccount.com",
  serviceAccountEmail: "admin@sample-project.iam.gserviceaccount.com",
  vapidPublicKey: `B${"A".repeat(86)}`,
  vapidSubject: "mailto:ops@example.com",
  channelAdapters: "GetYourGuide/gyg-browser@1=observe+close+open",
};
const secretRef = (target: Target, item: Item) => (target === "stg" ? `${item.stg}:3` : `sample-${item.variable.toLowerCase().replaceAll("_", "-")}:2`);

/** Each flag's config setting: a new flag without one here fails "covers every flag". */
const CONFIG_KEY: Record<string, keyof ReturnType<typeof resolveConfig>> = {
  ADMIN_SUPPORT_CONSOLE_ENABLED: "adminSupportConsoleEnabled",
  EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED: "articleAuthorityApiEnabled",
  GUIDE_ADMIN_API_ENABLED: "guideAdminApiEnabled",
  EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED: "hostArticleLinksEnabled",
  EXPERIENCE_GUIDE_PUBLIC_SOURCE: "guidePublicSource",
  EXPERIENCE_GUIDE_APP_CARDS_ENABLED: "guideAppCardsEnabled",
  EXPERIENCE_GUEST_BOOKING_ENABLED: "guestBookingEnabled",
  EXPERIENCE_GUEST_MAIL_ENABLED: "guestMailEnabled",
  EXPERIENCE_PUBLICATIONS_ENABLED: "experiencePublicationsEnabled",
  EXPERIENCE_HOST_PUBLICATION_API_ENABLED: "experienceHostPublicationApiEnabled",
  EXPERIENCE_PROVIDER_PAGES_API_ENABLED: "experienceProviderPagesApiEnabled",
  EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED: "experienceProviderOperationsApiEnabled",
  EXPERIENCE_TRANSLATE_API_ENABLED: "experienceTranslateApiEnabled",
  EXPERIENCE_GUEST_QUESTIONS_ENABLED: "guestQuestionsEnabled",
  EXPERIENCE_TRANSLATION_ENABLED: "translationEnabled",
  EXPERIENCE_GUEST_REVIEWS_ENABLED: "guestReviewsEnabled",
  EXPERIENCE_HOST_ATTENDANCE_ENABLED: "hostAttendanceEnabled",
  HOST_SALES_LEDGER_ENABLED: "hostSalesLedgerEnabled",
  HOST_SALES_PAYOUTS_ENABLED: "hostSalesPayoutsEnabled",
  HOST_NOTIFICATION_SETTINGS_ENABLED: "hostNotificationSettingsEnabled",
  EXPERIENCE_HOST_CALENDAR_FEED_ENABLED: "hostCalendarFeedEnabled",
  HOST_PWA_ENABLED: "hostPwaEnabled",
  HOST_PUSH_ENABLED: "hostPushEnabled",
  EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED: "googleBusySyncEnabled",
  EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED: "googleBookingEventsEnabled",
  EXPERIENCE_OTA_GUEST_DETAILS_ENABLED: "otaGuestDetailsEnabled",
  EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED: "otaBookingNotificationsEnabled",
  EXPERIENCE_HOST_MAIL_ENABLED: "hostMailEnabled",
  EXPERIENCE_JAPANESE_SITE_ENABLED: "japaneseSiteEnabled",
  EXPERIENCE_CHANNEL_WATCHDOG_ENABLED: "channelWatchdogEnabled",
  EXPERIENCE_CHANNEL_MANAGER_ENABLED: "channelManagerEnabled",
  EXPERIENCE_CHANNEL_RUNTIME_ENABLED: "channelRuntimeEnabled",
  EXPERIENCE_RESOURCE_GOOGLE_ENABLED: "resourceGoogleEnabled",
  EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED: "resourceGoogleWatchEnabled",
  EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED: "airbnbGoogleSetupEnabled",
  EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED: "airbnbGoogleActivationEnabled",
  EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED: "airbnbGoogleDeliveryEnabled",
  EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED: "airbnbGoogleObservationEnabled",
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
const SECRET_VALUE: Record<string, string> = { ADMIN_SESSION_SECRET: "a".repeat(48), EXPERIENCE_SMTP_HOST: "smtp.example.com", EXPERIENCE_SMTP_PORT: "587", HOST_PUSH_VAPID_PRIVATE_KEY: "A".repeat(43), EXPERIENCE_CALENDAR_FEED_KEY: `${"A".repeat(43)}=` };

/** The revision's environment: the base, the table's values, and a synthetic value for each Secret reference. */
function revision(target: Target, resolved: Resolved): Record<string, string> {
  return { ...BASE, SITE_URL: SITE[target], ...resolved.env, ...Object.fromEntries(Object.keys(resolved.secrets).map((name) => [name, SECRET_VALUE[name] ?? `synthetic-${name.toLowerCase()}`])) };
}

const resolve = (target: Target, vars: Vars, hostConsole = true) => resolveDeployFlags({
  target,
  vars: { [`${PREFIX[target]}_NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE`]: NIHO_API_AUDIENCE[target], ...vars },
  hostConsole,
  siteUrl: SITE[target],
});

describe("the deploy workflows' feature flags", () => {
  it("keeps Admin off by default and derives its callback origin with a pinned dedicated key", () => {
    const vars = closure("stg", "ADMIN_SUPPORT_CONSOLE_ENABLED");
    const resolved = resolve("stg", vars);
    expect(resolved.problems).toEqual([]);
    expect(resolved.env.NIHO_EXPERIENCE_ADMIN_ORIGIN).toBe(SITE.stg);
    expect(resolved.secrets.ADMIN_SESSION_SECRET).toBe("experience-stg-admin-session-secret:3");
    expect(resolveConfig(revision("stg", resolved)).adminSupportConsoleEnabled).toBe(true);
    expect(resolve("prod", {}).env.ADMIN_SUPPORT_CONSOLE_ENABLED).toBeUndefined();
    delete vars.STG_ADMIN_SESSION_SECRET_REF;
    expect(resolve("stg", vars).problems.join(" ")).toContain("STG_ADMIN_SESSION_SECRET_REF");
  });
  it("keeps the two article service callers in one deployment value", () => {
    const vars = closure("prod", "EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED");
    vars.PROD_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS = "niho@sample-project.iam.gserviceaccount.com;editor@sample-project.iam.gserviceaccount.com";
    const resolved = resolve("prod", vars);
    expect(resolved.problems).toEqual([]);
    expect(outputsOf(resolved).env!.split(",")).toHaveLength(Object.keys(resolved.env).length);
    expect(resolveConfig(revision("prod", resolved)).articleAuthorityServiceAccountEmails).toEqual([
      "niho@sample-project.iam.gserviceaccount.com", "editor@sample-project.iam.gserviceaccount.com",
    ]);
    vars.PROD_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS += ";EDITOR_AUTH_MODE=stub";
    expect(resolve("prod", vars).problems.join(" ")).toContain("PROD_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS");
  });

  it("configures the private Guide Admin API for one service account and a Cloud Run service URL audience", () => {
    const vars = closure("prod", "GUIDE_ADMIN_API_ENABLED");
    vars.PROD_GUIDE_ADMIN_AUDIENCE = "https://niho-experience-sample-an.a.run.app";
    vars.PROD_GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL = "guide-admin@sample-project.iam.gserviceaccount.com";
    const resolved = resolve("prod", vars);
    expect(resolved.problems).toEqual([]);
    expect(resolved.env).toEqual({
      NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.prod,
      GUIDE_ADMIN_API_ENABLED: "true",
      GUIDE_ADMIN_AUDIENCE: "https://niho-experience-sample-an.a.run.app",
      GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL: "guide-admin@sample-project.iam.gserviceaccount.com",
    });
    expect(resolveConfig(revision("prod", resolved))).toMatchObject({
      guideAdminApiEnabled: true,
      guideAdminAudience: "https://niho-experience-sample-an.a.run.app",
      guideAdminServiceAccountEmail: "guide-admin@sample-project.iam.gserviceaccount.com",
    });
    const invalid = resolve("prod", { ...vars, PROD_GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL: "person@example.com" });
    expect(invalid.problems.join(" ")).toContain("PROD_GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL");
    expect(invalid.problems.join(" ")).not.toContain("person@example.com");
    expect(resolve("prod", { ...vars, PROD_GUIDE_ADMIN_AUDIENCE: "https://experience.niho.life" }).problems.join(" ")).toContain("PROD_GUIDE_ADMIN_AUDIENCE");
    expect(resolve("prod", { PROD_GUIDE_ADMIN_API_ENABLED: "true" }).problems.join(" ")).toContain("PROD_GUIDE_ADMIN_AUDIENCE");
  });

  it("requires current authority before switching the publication source", () => {
    const vars = closure("prod", "EXPERIENCE_GUIDE_PUBLIC_SOURCE");
    vars.PROD_ARTICLE_AUTHORITY_API_ENABLED = "false";
    expect(resolve("prod", vars).problems.join(" ")).toContain("EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED");
    const enabled = resolve("prod", closure("prod", "EXPERIENCE_GUIDE_PUBLIC_SOURCE"));
    expect(enabled.env.EXPERIENCE_GUIDE_PUBLIC_SOURCE).toBe("editor");
    expect(enabled.env.GUIDE_EDITOR_API_HANDLE).toBe("exp");
    expect(enabled.secrets.GUIDE_EDITOR_API_TOKEN).toMatch(/:[1-9][0-9]*$/);
  });

  it("requires the Editor publication source before exposing app cards", () => {
    const vars = closure("prod", "EXPERIENCE_GUIDE_APP_CARDS_ENABLED");
    vars.PROD_EDITOR_PUBLICATIONS_ENABLED = "false";
    expect(resolve("prod", vars).problems.join(" ")).toContain("EXPERIENCE_GUIDE_PUBLIC_SOURCE");
    const enabled = resolve("prod", closure("prod", "EXPERIENCE_GUIDE_APP_CARDS_ENABLED"));
    expect(resolveConfig(revision("prod", enabled)).guideAppCardsEnabled).toBe(true);
  });

  it("opens Experience booking translation with the host console and database without enabling guest sales", () => {
    const vars = closure("stg", "EXPERIENCE_TRANSLATE_API_ENABLED");
    expect(vars.STG_TRANSLATE_API_ENABLED).toBe("true");
    expect(vars.STG_GUEST_BOOKING_ENABLED).toBeUndefined();
    const resolved = resolve("stg", vars);
    expect(resolved.problems).toEqual([]);
    expect(resolved.env).toEqual({ NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.stg, EXPERIENCE_TRANSLATE_API_ENABLED: "true", HOST_PWA_ENABLED: "true" });
    expect(resolved.secrets).toEqual({});
    expect(resolveConfig(revision("stg", resolved))).toMatchObject({ guestBookingEnabled: false, experienceTranslateApiEnabled: true });
  });
  it("requires the NIHO API audience whenever the host console is deployed, independently of publication flags", () => {
    const variable = "STG_NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE";
    const input = { target: "stg" as const, hostConsole: true, siteUrl: SITE.stg };
    const missing = resolveDeployFlags({ ...input, vars: {} });
    expect(missing.problems.join(" ")).toContain(variable);
    expect(missing.on).toEqual(["HOST_PWA_ENABLED"]);
    expect(missing.env).toEqual({ HOST_PWA_ENABLED: "true" });
    const malformed = resolveDeployFlags({ ...input, vars: { [variable]: "https://experience.niho.life/path?secret" } });
    expect(malformed.problems.join(" ")).toContain(variable);
    expect(malformed.problems.join(" ")).not.toContain("?secret");
    const valid = resolve("stg", {});
    expect(valid.problems).toEqual([]);
    expect(valid.env).toEqual({ NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.stg, HOST_PWA_ENABLED: "true" });
  });
  it("puts the OTA watchdog on a revision exactly as the workflows wired it by hand before the table (#194)", () => {
    // Staging: audience SITE_URL; production: https://experience.niho.life. Each project's experience-ota-watchdog caller.
    const project: Record<Target, string> = { stg: "niho-app-stg", prod: "niho-app-prd" };
    for (const target of ["stg", "prod"] as const) {
      const resolved = resolve(target, { [`${PREFIX[target]}_CHANNEL_WATCHDOG_ENABLED`]: "true" });
      expect(resolved.problems, target).toEqual([]);
      const env = Object.fromEntries(Object.entries(resolved.env).filter(([name]) => name.includes("CHANNEL")));
      // Besides the watchdog's three: only the host console's audience (and staging's PWA, on by default).
      expect(Object.keys(resolved.env).filter((name) => !name.includes("CHANNEL")).sort(), target).toEqual(
        target === "stg" ? ["HOST_PWA_ENABLED", "NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE"] : ["NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE"],
      );
      expect(env, target).toEqual({
        EXPERIENCE_CHANNEL_WATCHDOG_ENABLED: "true",
        EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE: SITE[target],
        EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL: `experience-ota-watchdog@${project[target]}.iam.gserviceaccount.com`,
      });
      expect(resolved.secrets, target).toEqual({});
      expect(resolveConfig(revision(target, resolved)).channelWatchdogEnabled, target).toBe(true);
    }
    expect(resolve("prod", {}).env.EXPERIENCE_CHANNEL_WATCHDOG_ENABLED).toBeUndefined();
    // Production refused the watchdog without the host calendar; the table refuses it the same way.
    expect(resolve("prod", { PROD_CHANNEL_WATCHDOG_ENABLED: "true" }, false).problems).toEqual([
      "EXPERIENCE_CHANNEL_WATCHDOG_ENABLED (PROD_CHANNEL_WATCHDOG_ENABLED) needs enable_host_calendar=true",
    ]);
  });

  it("takes the OTA adapters only in the short form without commas or spaces", () => {
    const vars = closure("stg", "EXPERIENCE_CHANNEL_RUNTIME_ENABLED");
    const accepted = [
      "GetYourGuide/gyg-browser@1=observe+close+open",
      "GetYourGuide/gyg-browser@1=observe+readReservations;Viator/viator.api_v2@12=observe+close+open+create",
    ];
    for (const adapters of accepted) {
      const resolved = resolve("stg", { ...vars, STG_CHANNEL_SUPPORTED_ADAPTERS: adapters });
      expect(resolved.problems, adapters).toEqual([]);
      expect(resolved.env.EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS).toBe(adapters);
      expect(resolveConfig(revision("stg", resolved)).channelRuntimeEnabled, adapters).toBe(true);
    }
    const refused = [
      "",
      "GetYourGuide/gyg-browser@1=observe,close",
      "GetYourGuide/gyg-browser@1=observe;Viator/viator@1=close,open",
      "GetYourGuide/gyg-browser@1=observe + close",
      " GetYourGuide/gyg-browser@1=observe",
      "GetYourGuide/gyg-browser@1=",
      "GetYourGuide/gyg-browser@1=observe;",
      "GetYourGuide/gyg-browser@v1=observe",
      "gyg-browser@1=observe",
      "GetYourGuide/gyg-browser@1=delete",
      "{\"GetYourGuide/gyg-browser@1\":{\"canObserve\":true}}",
    ];
    for (const adapters of refused) {
      const { problems } = resolve("stg", { ...vars, STG_CHANNEL_SUPPORTED_ADAPTERS: adapters });
      expect(problems, adapters).toHaveLength(1);
      expect(problems[0], adapters).toContain("STG_CHANNEL_SUPPORTED_ADAPTERS");
      if (adapters) expect(problems[0], adapters).not.toContain(adapters);
    }
  });

  it("opens the OTA runtime only with the Admin console behind the channel manager, and the watchdog", () => {
    const vars = closure("prod", "EXPERIENCE_CHANNEL_RUNTIME_ENABLED");
    expect(vars).toMatchObject({ PROD_ADMIN_SUPPORT_CONSOLE_ENABLED: "true", PROD_CHANNEL_MANAGER_ENABLED: "true", PROD_CHANNEL_WATCHDOG_ENABLED: "true" });
    expect(resolve("prod", vars).problems).toEqual([]);
    const withoutAdmin = resolve("prod", { ...vars, PROD_ADMIN_SUPPORT_CONSOLE_ENABLED: "false" }).problems;
    expect(withoutAdmin).toEqual(["EXPERIENCE_CHANNEL_MANAGER_ENABLED (PROD_CHANNEL_MANAGER_ENABLED) needs ADMIN_SUPPORT_CONSOLE_ENABLED"]);
    const withoutWatchdog = resolve("prod", { ...vars, PROD_CHANNEL_WATCHDOG_ENABLED: "false" }).problems;
    expect(withoutWatchdog).toEqual(["EXPERIENCE_CHANNEL_RUNTIME_ENABLED (PROD_CHANNEL_RUNTIME_ENABLED) needs EXPERIENCE_CHANNEL_WATCHDOG_ENABLED"]);
  });

  it("points the Google calendar watch at the stable site's webhook", () => {
    for (const target of ["stg", "prod"] as const) {
      const resolved = resolve(target, closure(target, "EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED"));
      expect(resolved.problems, target).toEqual([]);
      expect(resolved.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL, target).toBe(`${SITE[target]}/api/google/calendar/watch`);
      expect(resolveConfig(revision(target, resolved)).resourceGoogleWatchEnabled, target).toBe(true);
    }
  });

  it("covers every flag of the table with a config setting", () => {
    expect(FLAGS.map((flag) => flag.env).sort()).toEqual(Object.keys(CONFIG_KEY).sort());
    expect(new Set(FLAGS.map((flag) => flag.variable)).size).toBe(FLAGS.length);
  });

  it("keeps everything off by default (staging keeps the app it always had)", () => {
    expect(resolve("prod", {})).toEqual({ problems: [], on: [], env: { NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.prod }, secrets: {}, names: tableNames() });
    expect(resolve("stg", {})).toMatchObject({ problems: [], on: ["HOST_PWA_ENABLED"], env: { NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.stg, HOST_PWA_ENABLED: "true" }, secrets: {} });
    expect(resolve("stg", { STG_HOST_PWA_ENABLED: "false" })).toMatchObject({ problems: [], on: [], env: { NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.stg } });
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
        expect(config[CONFIG_KEY[flag.env]!], flag.env).toBe(flag.value ?? true);
      }
    });

    it(`${target}: every compatible flag starts the server and turns on in resolve-config`, () => {
      const vars = Object.assign({}, ...FLAGS.map((flag) => varsOf(target, flag))) as Vars;
      const resolved = resolve(target, vars);
      expect(resolved.problems).toEqual([]);
      expect(resolved.on).toEqual(FLAGS.map((flag) => flag.env));
      const config = resolveConfig(revision(target, resolved));
      for (const flag of FLAGS) expect(config[CONFIG_KEY[flag.env]!], flag.env).toBe(flag.value ?? true);
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
    expect(outputsOf(resolve("prod", {}))).toEqual({
      env: `NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE=${NIHO_API_AUDIENCE.prod}`,
      secrets: "",
      expected_env: JSON.stringify({ NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.prod }),
      expected_secrets: "{}",
      names: JSON.stringify(tableNames()),
      summary: "none",
    });
  });

  it("runs as the workflows run it: outputs to $GITHUB_OUTPUT, or every problem as an error and exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-flags-"));
    try {
      const output = join(dir, "output");
      const run = (vars: Vars, args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DEPLOY_VARS: JSON.stringify(vars), GITHUB_OUTPUT: output }, encoding: "utf8" });
      const ok = run({ PROD_GUEST_REVIEWS_ENABLED: "true", PROD_GCP_PROJECT_ID: "niho-app-prd", PROD_NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.prod }, ["--target", "prod", "--host-console", "true", "--site-url", SITE.prod]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("Feature flags on: EXPERIENCE_GUEST_REVIEWS_ENABLED");
      const lines = readFileSync(output, "utf8").trim().split("\n");
      expect(lines.map((line) => line.slice(0, line.indexOf("=")))).toEqual(["env", "secrets", "expected_env", "expected_secrets", "names", "summary"]);
      expect(lines[0]).toBe(`env=EXPERIENCE_GUEST_REVIEWS_ENABLED=true,NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE=${NIHO_API_AUDIENCE.prod}`);
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
    { file: "deploy-production.yml", target: "prod", jobs: ["deploy", "promote"], originReadback: /select\(\.name == "GUIDE_EDITOR_SITE_ORIGIN"\) \| \.value' <<< "\$revision_json"\)" = https:\/\/editor\.niho\.life/ },
    { file: "deploy-host-staging.yml", target: "stg", jobs: ["deploy"], originReadback: /GUIDE_EDITOR_SITE_ORIGIN:"https:\/\/editor\.niho\.life"/ },
  ] as const;
  const EDITOR_SITE_ORIGIN = "GUIDE_EDITOR_SITE_ORIGIN";

  /** A job's text, from its key to the next job. */
  function job(text: string, name: string): string {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(0);
    const next = text.slice(start + 1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  }

  for (const { file, target, jobs, originReadback } of WORKFLOWS) {
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

    it(`${file} sets the writers' entrance origin on every revision and reads it back, as a fixed value outside the table (#254)`, () => {
      // The entrance is independent of every flag. A name of the table is checked as absent from a revision whose flag is
      // off, so the origin in the table would fail the readback of any revision the workflow gave it by hand.
      expect(tableNames()).not.toContain(EDITOR_SITE_ORIGIN);
      const text = workflow(file);
      expect(text.split(`${EDITOR_SITE_ORIGIN}=https://editor.niho.life`).length - 1).toBe(1);
      expect(text).toMatch(originReadback);
      if (target === "prod") expect(text.match(new RegExp(originReadback.source, "g"))?.length).toBe(jobs.length);
    });
  }
});
