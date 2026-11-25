export type Ga4ConsentChoice = "granted" | "denied";

export const GA4_CONSENT_STORAGE_KEY = "niho-experience-ga4-consent-v1";
export const GA4_CONSENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const GA4_COOKIE_EXPIRES_SECONDS = 60 * 24 * 60 * 60;
export const GA4_COOKIE_PREFIX = "niho_experience";
export const ANALYTICS_PREFERENCES_EVENT = "niho:open-analytics-preferences";

type ConsentState = "granted" | "denied";
export type Ga4ConsentDefault = Readonly<{
  ad_storage: ConsentState;
  ad_user_data: ConsentState;
  ad_personalization: ConsentState;
  analytics_storage: ConsentState;
}>;

export type StoredGa4Consent = Readonly<{
  choice: Ga4ConsentChoice;
  expiresAt: number;
}>;

export type Ga4ConsentStorage = Pick<Storage, "getItem" | "setItem">;

/** Keep the current tab's explicit choice usable when browser storage rejects a write. */
export function createGa4ConsentChoiceStore(storage: Ga4ConsentStorage) {
  let fallbackChoice: Ga4ConsentChoice | null = null;
  let writeFailed = false;

  return {
    read(now = Date.now()): Ga4ConsentChoice | null {
      try {
        const choice = parseStoredGa4Consent(storage.getItem(GA4_CONSENT_STORAGE_KEY), now);
        if (writeFailed) return fallbackChoice;
        fallbackChoice = choice;
        return choice;
      } catch {
        return fallbackChoice;
      }
    },
    save(choice: Ga4ConsentChoice, now = Date.now()): void {
      fallbackChoice = choice;
      try {
        storage.setItem(GA4_CONSENT_STORAGE_KEY, serializeGa4Consent(choice, now));
        writeFailed = false;
      } catch {
        writeFailed = true;
      }
    },
    /** Another tab changed or cleared localStorage; let that persisted value take precedence. */
    syncFromStorage(): void {
      fallbackChoice = null;
      writeFailed = false;
    },
  };
}

/** Basic consent mode: this is sent only after an affirmative choice and before the Google tag is loaded. */
export function ga4ConsentDefaults(): Ga4ConsentDefault {
  return {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  };
}

/** The GA4 cookie is site scoped and expires after 60 days without sliding renewal. */
export const GA4_COOKIE_SETTINGS = {
  cookie_domain: "travel.niho.life",
  cookie_expires: GA4_COOKIE_EXPIRES_SECONDS,
  cookie_path: "/",
  cookie_prefix: GA4_COOKIE_PREFIX,
  cookie_update: false,
} as const;

/** Return only cookies owned by this site's GA4 cookie prefix. */
export function ga4CookieNames(cookieHeader: string): string[] {
  const cookiePrefix = `${GA4_COOKIE_PREFIX}_ga`;
  return [...new Set(cookieHeader.split(";").map((cookie) => cookie.split("=", 1)[0]?.trim() ?? "").filter((name) =>
    name === cookiePrefix || name.startsWith(`${cookiePrefix}_`),
  ))];
}

export function parseStoredGa4Consent(raw: string | null, now = Date.now()): Ga4ConsentChoice | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredGa4Consent>;
    if ((value.choice !== "granted" && value.choice !== "denied") || typeof value.expiresAt !== "number" || value.expiresAt <= now) return null;
    return value.choice;
  } catch {
    return null;
  }
}

export function serializeGa4Consent(choice: Ga4ConsentChoice, now = Date.now()): string {
  const value: StoredGa4Consent = { choice, expiresAt: now + GA4_CONSENT_RETENTION_MS };
  return JSON.stringify(value);
}

export function shouldLoadGa4(choice: Ga4ConsentChoice | null, doNotTrack: string | null | undefined): boolean {
  return choice === "granted" && doNotTrack !== "1" && doNotTrack !== "yes";
}

/** Cookie deletion must wait until the browser's persisted consent has hydrated. */
export function shouldStopGa4(
  choice: Ga4ConsentChoice | null,
  ready: boolean,
  doNotTrack: string | null | undefined,
): boolean {
  return ready && !shouldLoadGa4(choice, doNotTrack);
}

export function shouldMeasureGa4Path(
  choice: Ga4ConsentChoice | null,
  doNotTrack: string | null | undefined,
  pathname: string,
): boolean {
  return shouldLoadGa4(choice, doNotTrack) && !isGa4ExcludedPath(pathname);
}

/** Never collect GA4 views from booking, member, host or admin flows. */
export function isGa4ExcludedPath(pathname: string): boolean {
  return pathname === "/booking" || pathname.startsWith("/booking/")
    || pathname === "/bookings" || pathname.startsWith("/bookings/")
    || pathname === "/reviews/write"
    || pathname === "/host" || pathname.startsWith("/host/")
    || pathname === "/admin" || pathname.startsWith("/admin/")
    || pathname === "/account" || pathname.startsWith("/account/")
    || /^\/experiences\/[^/]+\/book$/.test(pathname);
}
