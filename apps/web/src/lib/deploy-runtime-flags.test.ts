import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NIHO_ADMIN_TOKEN_FLAGS, resolveConfig } from "./resolve-config";

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
  id?: string;
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
  sellerReference: "seller_sample",
  sellerName: "試験用販売事業者",
  stripeAccount: "acct_SampleManaged1",
  bucketName: "experience-test-public-media",
  mailbox: "NIHO Sample <noreply@example.com>",
  httpsUrl: "https://example.com/privacy",
  httpsOrigin: "https://editor.example.com",
  cloudRunServiceUrl: "https://niho-experience-sample-an.a.run.app",
  serviceAccountList: "caller@sample-project.iam.gserviceaccount.com",
  serviceAccountEmail: "admin@sample-project.iam.gserviceaccount.com",
  adminAllowedEmails: "admin.sample@niho.life;ops.sample@niho.life",
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
  DATABASE_GUIDE_PUBLICATIONS: "guidePublicSource",
  EXPERIENCE_GUEST_BOOKING_ENABLED: "guestBookingEnabled",
  EXPERIENCE_MANAGED_SALES_ENABLED: "managedSalesEnabled",
  EXPERIENCE_MANAGED_SALES_WEBHOOKS_ENABLED: "managedSalesWebhooksEnabled",
  EXPERIENCE_GUEST_MAIL_ENABLED: "guestMailEnabled",
  EXPERIENCE_PUBLICATIONS_ENABLED: "experiencePublicationsEnabled",
  EXPERIENCE_HOST_PUBLICATION_API_ENABLED: "experienceHostPublicationApiEnabled",
  EXPERIENCE_PROVIDER_PAGES_API_ENABLED: "experienceProviderPagesApiEnabled",
  EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED: "experienceProviderOperationsApiEnabled",
  EXPERIENCE_TRANSLATE_API_ENABLED: "experienceTranslateApiEnabled",
  EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED: "experienceTranslateStandaloneApiEnabled",
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
  EXPERIENCE_HOST_ACCOUNTS_ENABLED: "hostAccountsEnabled",
  EXPERIENCE_HOST_TEAM_ENABLED: "hostTeamEnabled",
  EXPERIENCE_OCCURRENCE_ASSIGNMENT_ENABLED: "occurrenceAssignmentEnabled",
  EXPERIENCE_JAPANESE_SITE_ENABLED: "japaneseSiteEnabled",
  EXPERIENCE_CHANNEL_WATCHDOG_ENABLED: "channelWatchdogEnabled",
  EXPERIENCE_CHANNEL_MANAGER_ENABLED: "channelManagerEnabled",
  EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED: "adminGoogleLoginEnabled",
  EXPERIENCE_CHANNEL_RUNTIME_ENABLED: "channelRuntimeEnabled",
  EXPERIENCE_RESOURCE_GOOGLE_ENABLED: "resourceGoogleEnabled",
  EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED: "resourceGoogleWatchEnabled",
  EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED: "airbnbGoogleSetupEnabled",
  EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED: "airbnbGoogleActivationEnabled",
  EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED: "airbnbGoogleDeliveryEnabled",
  EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED: "airbnbGoogleObservationEnabled",
};

const flagId = (flag: Flag) => flag.id ?? flag.env;
const byId = new Map(FLAGS.map((flag) => [flagId(flag), flag]));

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
function closure(target: Target, id: string, seen = new Set<string>()): Vars {
  if (seen.has(id)) return {};
  seen.add(id);
  const flag = byId.get(id)!;
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

  it("configures the database Guide source with its private media bucket", () => {
    const enabled = resolve("prod", closure("prod", "DATABASE_GUIDE_PUBLICATIONS"));
    expect(enabled.problems).toEqual([]);
    expect(enabled.on).toContain("DATABASE_GUIDE_PUBLICATIONS");
    expect(enabled.env.EXPERIENCE_GUIDE_PUBLIC_SOURCE).toBe("database");
    expect(enabled.env.GUIDE_MEDIA_BUCKET).toBe(SETTING.bucketName);
    expect(resolveConfig(revision("prod", enabled)).guidePublicSource).toBe("database");

    const missing = closure("prod", "DATABASE_GUIDE_PUBLICATIONS");
    delete missing.PROD_GUIDE_MEDIA_BUCKET;
    expect(resolve("prod", missing).problems.join(" ")).toContain("PROD_GUIDE_MEDIA_BUCKET");
    const invalid = { ...closure("prod", "DATABASE_GUIDE_PUBLICATIONS"), PROD_GUIDE_MEDIA_BUCKET: "Not A Bucket" };
    expect(resolve("prod", invalid).problems.join(" ")).toContain("PROD_GUIDE_MEDIA_BUCKET");

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
  it("opens reservation-free translation only with the Host Account session and the NIHO service audience", () => {
    const vars = closure("stg", "EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED");
    expect(vars.STG_TRANSLATE_STANDALONE_API_ENABLED).toBe("true");
    expect(vars.STG_TRANSLATE_API_ENABLED).toBeUndefined();
    const resolved = resolve("stg", vars);
    expect(resolved.problems).toEqual([]);
    expect(resolved.env.EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED).toBe("true");
    expect(resolved.env.EXPERIENCE_HOST_ACCOUNTS_ENABLED).toBe("true");
    expect(resolved.env.NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE).toBe(NIHO_API_AUDIENCE.stg);
    expect(resolveConfig(revision("stg", resolved))).toMatchObject({
      hostAccountsEnabled: true,
      experienceTranslateApiEnabled: false,
      experienceTranslateStandaloneApiEnabled: true,
    });
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
    expect(FLAGS.map(flagId).sort()).toEqual(Object.keys(CONFIG_KEY).sort());
    expect(new Set(FLAGS.map((flag) => flag.variable)).size).toBe(FLAGS.length);
  });

  it("keeps everything off by default (staging keeps the app it always had)", () => {
    expect(resolve("prod", {})).toEqual({ problems: [], on: [], env: { NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.prod }, secrets: {}, names: tableNames() });
    expect(resolve("stg", {})).toMatchObject({ problems: [], on: ["HOST_PWA_ENABLED"], env: { NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.stg, HOST_PWA_ENABLED: "true" }, secrets: {} });
    expect(resolve("stg", { STG_HOST_PWA_ENABLED: "false" })).toMatchObject({ problems: [], on: [], env: { NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: NIHO_API_AUDIENCE.stg } });
    // Variables of the other workflow are not read.
    expect(resolve("prod", { STG_GUEST_REVIEWS_ENABLED: "true" }).on).toEqual([]);
  });

  it("keeps the account webhook wired when the pilot stops new sales", () => {
    const vars = closure("prod", "EXPERIENCE_MANAGED_SALES_ENABLED");
    const open = resolve("prod", vars);
    expect(open.problems).toEqual([]);
    expect(open.env.EXPERIENCE_MANAGED_SALES_ENABLED).toBe("true");
    expect(open.secrets.EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET).not.toBe(open.secrets.EXPERIENCE_STRIPE_WEBHOOK_SECRET);

    const stopped = resolve("prod", { ...vars, PROD_MANAGED_SALES_ENABLED: "false" });
    expect(stopped.problems).toEqual([]);
    expect(stopped.env.EXPERIENCE_MANAGED_SALES_ENABLED).toBeUndefined();
    expect(stopped.env.EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID).toBe(open.env.EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID);
    expect(stopped.secrets.EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET).toBe(open.secrets.EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET);
    expect(stopped.secrets.EXPERIENCE_MANAGED_PROVIDER_MAIL_RECIPIENTS).toBe(open.secrets.EXPERIENCE_MANAGED_PROVIDER_MAIL_RECIPIENTS);

    const sharedSecret = resolve("prod", { ...vars, PROD_STRIPE_PLATFORM_WEBHOOK_SECRET_REF: vars.PROD_STRIPE_WEBHOOK_SECRET_REF! });
    expect(sharedSecret.problems).toContain("PROD_STRIPE_PLATFORM_WEBHOOK_SECRET_REF must differ from PROD_STRIPE_WEBHOOK_SECRET_REF");
  });

  it("requires booking mail for managed sales and accepts an optional versioned provider destination secret", () => {
    const vars = closure("prod", "EXPERIENCE_MANAGED_SALES_ENABLED");
    const open = resolve("prod", vars);
    expect(open.problems).toEqual([]);
    expect(open.secrets.EXPERIENCE_MANAGED_PROVIDER_MAIL_RECIPIENTS).toBe(vars.PROD_MANAGED_PROVIDER_MAIL_RECIPIENTS_REF);
    expect(resolve("prod", { ...vars, PROD_MANAGED_PROVIDER_MAIL_RECIPIENTS_REF: "" }).problems).toEqual([]);
    expect(resolve("prod", { ...vars, PROD_MANAGED_PROVIDER_MAIL_RECIPIENTS_REF: "example:latest" }).problems.join(" ")).toContain("PROD_MANAGED_PROVIDER_MAIL_RECIPIENTS_REF");
    expect(resolve("prod", { ...vars, PROD_GUEST_MAIL_ENABLED: "false" }).problems.join(" ")).toContain("EXPERIENCE_GUEST_MAIL_ENABLED");
  });

  for (const target of ["stg", "prod"] as const) {
    it(`${target}: each flag with what it needs starts the server and turns on in resolve-config`, () => {
      for (const flag of FLAGS) {
        const id = flagId(flag);
        const resolved = resolve(target, closure(target, id));
        expect(resolved.problems, id).toEqual([]);
        expect(resolved.on, id).toContain(id);
        const config = resolveConfig(revision(target, resolved));
        expect(config[CONFIG_KEY[id]!], id).toBe(flag.value ?? true);
      }
    });

    it(`${target}: every compatible flag starts the server and turns on in resolve-config`, () => {
      // Experience host accounts refuse the NIHO-token flags (its own test below), so it is left out here.
      const compatibleIds = new Set(FLAGS.filter((flag) => (flag.conflicts ?? []).length === 0).map(flagId));
      const compatible = FLAGS.filter((flag) =>
        (flag.conflicts ?? []).length === 0
        && (flag.needs ?? []).every((need) => need.split("|").some((dependency) => compatibleIds.has(dependency) || CAPABILITIES.includes(dependency)))
      );
      const vars = Object.assign({}, ...compatible.map((flag) => varsOf(target, flag))) as Vars;
      const resolved = resolve(target, vars);
      expect(resolved.problems).toEqual([]);
      expect(resolved.on).toEqual(compatible.map(flagId));
      const config = resolveConfig(revision(target, resolved));
      for (const flag of compatible) expect(config[CONFIG_KEY[flagId(flag)]!], flagId(flag)).toBe(flag.value ?? true);
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
          const vars = { ...closure(target, flagId(flag)) };
          for (const one of need.split("|")) vars[`${PREFIX[target]}_${byId.get(one)!.variable}`] = "false";
          const { problems } = resolve(target, vars);
          expect(problems.some((problem) => problem.includes(flagId(flag)) && need.split("|").every((one) => problem.includes(one))), `${flagId(flag)} needs ${need}`).toBe(true);
        }
      }
    });
  }

  it("refuses Experience host accounts with a flag that sends the NIHO host access token, as resolve-config does (ADR 0003)", () => {
    const accounts = byId.get("EXPERIENCE_HOST_ACCOUNTS_ENABLED")!;
    expect(accounts.conflicts).toEqual(expect.arrayContaining([
      "EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED", "EXPERIENCE_PROVIDER_PAGES_API_ENABLED", "EXPERIENCE_TRANSLATE_API_ENABLED", "EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED",
    ]));
    for (const target of ["stg", "prod"] as const) {
      for (const conflict of accounts.conflicts!) {
        const other = byId.get(conflict)!;
        const both = { ...closure(target, conflict), ...closure(target, accounts.env) };
        const { problems } = resolve(target, both);
        expect(problems, conflict).toContain(`EXPERIENCE_HOST_ACCOUNTS_ENABLED (${PREFIX[target]}_HOST_ACCOUNTS_ENABLED) conflicts with ${conflict} (${PREFIX[target]}_${other.variable})`);
        // The server would refuse the same revision at start-up.
        const forced = resolve(target, closure(target, accounts.env));
        expect(() => resolveConfig({ ...revision(target, forced), [conflict]: "true" }), conflict).toThrow(`cannot be on with ${conflict}=true`);
      }
    }
  });

  it("opens the Admin's Google login with the Admin console and its allowlist, and refuses it with a NIHO admin token flag (ADR 0003)", () => {
    for (const target of ["stg", "prod"] as const) {
      const name = (variable: string) => `${PREFIX[target]}_${variable}`;
      const vars = closure(target, "EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED");
      expect(vars[name("ADMIN_SUPPORT_CONSOLE_ENABLED")]).toBe("true");
      const resolved = resolve(target, vars);
      expect(resolved.problems).toEqual([]);
      expect(resolved.env.EXPERIENCE_ADMIN_ALLOWED_EMAILS).toBe(SETTING.adminAllowedEmails);
      const config = resolveConfig(revision(target, resolved));
      expect(config).toMatchObject({ adminGoogleLoginEnabled: true, adminAllowedEmails: ["admin.sample@niho.life", "ops.sample@niho.life"], adminOrigin: SITE[target] });
      // Missing or outside niho.life, the allowlist is named before anything is deployed, never its value.
      for (const bad of ["", "admin.sample@example.com", "admin.sample@niho.life,ops.sample@niho.life", "Admin.Sample@niho.life", "admin.sample@niho.life; ops.sample@niho.life"]) {
        const problems = resolve(target, { ...vars, [name("ADMIN_ALLOWED_EMAILS")]: bad }).problems;
        expect(problems, bad).toHaveLength(1);
        expect(problems[0], bad).toContain(name("ADMIN_ALLOWED_EMAILS"));
        if (bad) expect(problems[0], bad).not.toContain(bad);
      }
      // The flags whose code sends NIHO's admin token are not in the table; the server refuses them at start-up.
      for (const flag of NIHO_ADMIN_TOKEN_FLAGS) {
        expect(tableNames(), flag).not.toContain(flag);
        expect(() => resolveConfig({ ...revision(target, resolved), [flag]: "true" }), flag).toThrow(`cannot be on with ${flag}=true`);
      }
    }
  });

  it("carries the payout settings with Experience host accounts, so the publication API starts with them (ADR 0003 slice 3)", () => {
    for (const target of ["stg", "prod"] as const) {
      const vars = { ...closure(target, "EXPERIENCE_HOST_PUBLICATION_API_ENABLED"), ...closure(target, "EXPERIENCE_HOST_ACCOUNTS_ENABLED") };
      const resolved = resolve(target, vars);
      expect(resolved.problems).toEqual([]);
      expect(resolved.env.EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION).toBe(SETTING.consentVersion);
      expect(Object.keys(resolved.secrets)).toContain("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY");
      const config = resolveConfig(revision(target, resolved));
      expect(config.hostAccountsEnabled).toBe(true);
      expect(config.experienceHostPublicationApiEnabled).toBe(true);
      expect(config.experiencePayoutAccountConsentVersion).toBe(SETTING.consentVersion);
      // Missing, they are named before anything is deployed.
      const name = (variable: string) => `${PREFIX[target]}_${variable}`;
      const without = Object.fromEntries(Object.entries(vars).filter(([key]) => key !== name("PAYOUT_ACCOUNT_CONSENT_VERSION") && key !== name("STRIPE_PLATFORM_SECRET_KEY_REF")));
      const problems = resolve(target, without).problems.join("\n");
      expect(problems).toContain(name("PAYOUT_ACCOUNT_CONSENT_VERSION"));
      expect(problems).toContain(name("STRIPE_PLATFORM_SECRET_KEY_REF"));
      // The server would refuse that revision at start-up too.
      const forced = resolve(target, { ...vars });
      const env = revision(target, forced);
      delete env.EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION;
      expect(() => resolveConfig(env)).toThrow("needs EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION");
    }
  });

  it("production: every flag needs enable_host_calendar=true (the host console and its database)", () => {
    for (const flag of FLAGS) {
      const id = flagId(flag);
      const { problems } = resolve("prod", closure("prod", id), false);
      expect(problems.some((problem) => problem.includes("enable_host_calendar=true")), id).toBe(true);
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

  it("deploy-production.yml opens search indexing and preserves the accepted booking switch in every job (owner 2026-11-07, #141)", () => {
    const text = workflow("deploy-production.yml");
    expect(text).toContain("SITE_INDEXING=allow,BOOKINGS_ENABLED=${BOOKINGS}");
    expect(text).not.toMatch(/SITE_INDEXING=block/);
    for (const name of ["deploy", "promote"]) {
      const body = job(text, name);
      expect(body, name).toContain(`select(.name == "SITE_INDEXING") | .value' <<< "$revision_json")" = allow`);
      expect(body, name).toContain(`select(.name == "BOOKINGS_ENABLED") | .value' <<< "$revision_json")" = "$BOOKINGS"`);
      expect(body, name).toContain("if grep -qxF 'Disallow: /' <<< \"$robots\"; then exit 1; fi");
      expect(body, name).toContain("grep -qxF 'Sitemap: https://experience.niho.life/sitemap.xml' <<< \"$robots\"");
    }
  });
});
