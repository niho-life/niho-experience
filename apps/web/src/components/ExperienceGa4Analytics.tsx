"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { doNotTrackEnabled, sanitizeUmamiPayload } from "@/lib/analytics";
import { LocalizedLink as Link } from "@/components/LocalizedLink";
import {
  ANALYTICS_PREFERENCES_EVENT,
  GA4_CONSENT_STORAGE_KEY,
  GA4_COOKIE_SETTINGS,
  createGa4ConsentChoiceStore,
  ga4ConsentDefaults,
  ga4CookieNames,
  isGa4ExcludedPath,
  shouldLoadGa4,
  shouldMeasureGa4Path,
  shouldStopGa4,
  type Ga4ConsentChoice,
} from "@/lib/ga4-consent";
import { createGtagQueue, type GtagCommand } from "@/lib/ga4-queue";

const EXPERIENCE_ORIGIN = "https://travel.niho.life";
const GA4_SCRIPT_ID = "niho-experience-ga4-tracker";
const GA4_CONSENT_CHANGE_EVENT = "niho:ga4-consent-change";
const MEASUREMENT_ID = /^G-[A-Za-z0-9]{4,24}$/;
const consentChoiceStore = createGa4ConsentChoiceStore({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
});

function subscribeToBrowserReady(): () => void {
  return () => {};
}

function getBrowserReadySnapshot(): boolean {
  return typeof window !== "undefined";
}

function getServerBrowserReadySnapshot(): boolean {
  return false;
}

function getServerConsentSnapshot(): null {
  return null;
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: GtagCommand;
    __nihoGa4MeasurementId?: string;
  }
}

type SafePageView = Readonly<{ location: string; title: string }>;

function safePageView(rawUrl: string): SafePageView | null {
  if (window.location.origin !== EXPERIENCE_ORIGIN || isGa4ExcludedPath(window.location.pathname)) return null;
  const payload = sanitizeUmamiPayload("pageview", { url: rawUrl }, window.location.origin);
  if (!payload || typeof payload.url !== "string" || typeof payload.title !== "string") return null;
  return { location: `${EXPERIENCE_ORIGIN}${payload.url}`, title: payload.title };
}

function safeReferrer(raw = document.referrer): string {
  try {
    const referrer = new URL(raw, window.location.origin);
    return referrer.protocol === "https:" || referrer.protocol === "http:" ? referrer.origin : "";
  } catch {
    return "";
  }
}

function ga4DisabledFlag(measurementId: string): string {
  return `ga-disable-${measurementId}`;
}

function clearGa4Cookies(): void {
  for (const name of ga4CookieNames(document.cookie)) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
    document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${GA4_COOKIE_SETTINGS.cookie_domain}; SameSite=Lax; Secure`;
  }
}

function stopGoogleTag(): void {
  const script = document.getElementById(GA4_SCRIPT_ID) as HTMLScriptElement | null;
  const measurementId = window.__nihoGa4MeasurementId ?? script?.dataset.measurementId;
  if (measurementId) Reflect.set(window, ga4DisabledFlag(measurementId), true);
  if (window.gtag) {
    window.gtag("consent", "update", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  }
  clearGa4Cookies();
}

function existingGoogleTagIsCompatible(measurementId: string): boolean {
  const existingScript = document.getElementById(GA4_SCRIPT_ID) as HTMLScriptElement | null;
  if (existingScript) return existingScript.dataset.measurementId === measurementId;
  // A tag installed elsewhere could have different URL collection settings.
  // Do not add a second one or configure an unreviewed tracker implicitly.
  return !document.querySelector('script[src*="googletagmanager.com/"]') &&
    (!window.gtag || window.__nihoGa4MeasurementId === measurementId);
}

function installGoogleTag(measurementId: string, page: SafePageView, pageReferrer: string): boolean {
  if (!existingGoogleTagIsCompatible(measurementId)) return false;
  if (!window.dataLayer) window.dataLayer = [];
  if (!window.gtag) window.gtag = createGtagQueue(window.dataLayer);

  const gtag = window.gtag;
  const configured = window.__nihoGa4MeasurementId === measurementId;
  Reflect.set(window, ga4DisabledFlag(measurementId), false);
  if (!configured) {
    window.__nihoGa4MeasurementId = measurementId;
    // Basic mode: set all consent defaults to denied, then grant analytics only after the visitor opted in.
    gtag("consent", "default", ga4ConsentDefaults());
    gtag("js", new Date());
    gtag("consent", "update", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    gtag("config", measurementId, {
      send_page_view: false,
      page_location: page.location,
      page_title: page.title,
      page_referrer: pageReferrer,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      ...GA4_COOKIE_SETTINGS,
    });
  } else {
    gtag("consent", "update", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  }

  if (!document.getElementById(GA4_SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = GA4_SCRIPT_ID;
    script.async = true;
    script.dataset.measurementId = measurementId;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(script);
  }
  return true;
}

function readChoice(): Ga4ConsentChoice | null {
  return consentChoiceStore.read();
}

function saveChoice(choice: Ga4ConsentChoice): void {
  consentChoiceStore.save(choice);
  window.dispatchEvent(new Event(GA4_CONSENT_CHANGE_EVENT));
}

function subscribeToChoice(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === GA4_CONSENT_STORAGE_KEY || event.key === null) consentChoiceStore.syncFromStorage();
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(GA4_CONSENT_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(GA4_CONSENT_CHANGE_EVENT, onChange);
  };
}

function AnalyticsConsentAndPageMeasurement({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const lastLocation = useRef<string | null>(null);
  const ready = useSyncExternalStore(subscribeToBrowserReady, getBrowserReadySnapshot, getServerBrowserReadySnapshot);
  const choice = useSyncExternalStore(subscribeToChoice, readChoice, getServerConsentSnapshot);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const dnt = doNotTrackEnabled(typeof navigator === "undefined" ? undefined : navigator.doNotTrack);

  useEffect(() => {
    if (shouldStopGa4(choice, ready, navigator.doNotTrack)) stopGoogleTag();
  }, [choice, ready]);

  useEffect(() => {
    const openPreferences = () => setPreferencesOpen(true);
    window.addEventListener(ANALYTICS_PREFERENCES_EVENT, openPreferences);
    return () => window.removeEventListener(ANALYTICS_PREFERENCES_EVENT, openPreferences);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!MEASUREMENT_ID.test(measurementId) || !shouldMeasureGa4Path(choice, navigator.doNotTrack, pathname)) {
      stopGoogleTag();
      lastLocation.current = null;
      return;
    }

    const rawUrl = `${pathname}${search ? `?${search}` : ""}`;
    const page = safePageView(rawUrl);
    if (!page) {
      stopGoogleTag();
      lastLocation.current = null;
      return;
    }
    if (lastLocation.current === page.location || !shouldLoadGa4(choice, navigator.doNotTrack)) return;

    const pageReferrer = lastLocation.current ? safeReferrer(lastLocation.current) : safeReferrer();
    if (!installGoogleTag(measurementId, page, pageReferrer) || !window.gtag || !shouldLoadGa4(choice, navigator.doNotTrack)) return;

    window.gtag("set", {
      page_location: page.location,
      page_title: page.title,
      page_referrer: pageReferrer,
    });
    window.gtag("event", "page_view", {
      page_location: page.location,
      page_title: page.title,
      page_referrer: pageReferrer,
    });
    lastLocation.current = page.location;
  }, [choice, measurementId, pathname, ready, search]);

  if (!measurementId || !ready) return null;

  const allowPrompt = !dnt && !isGa4ExcludedPath(pathname);
  const showPanel = preferencesOpen || (choice === null && allowPrompt);
  if (!showPanel) return null;

  const choose = (next: Ga4ConsentChoice) => {
    if (next === "granted" && doNotTrackEnabled(navigator.doNotTrack)) return;
    saveChoice(next);
    if (next === "denied") stopGoogleTag();
    setPreferencesOpen(false);
  };

  return (
    <section
      aria-labelledby="analytics-consent-title"
      className="fixed inset-x-4 bottom-4 z-[80] mx-auto max-w-3xl rounded-2xl border border-line bg-white p-5 shadow-xl sm:p-6"
      role="region"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="analytics-consent-title" className="text-lg font-extrabold">Your choice about analytics</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            {dnt
              ? "Do Not Track is enabled in this browser, so Google Analytics stays off. You can reject a saved choice here."
              : choice === "granted"
                ? "Optional Google Analytics is on for selected public page visits. You can turn it off at any time."
                : choice === "denied"
                  ? "Optional Google Analytics is off. You can allow it later from this page."
                  : "We use Google Analytics to count visits to selected public pages. It stays off unless you allow it. Your choice is saved in this browser for up to 180 days."}
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            <Link href="/privacy" className="font-bold text-moss underline underline-offset-4">Read our privacy notice</Link>
          </p>
        </div>
        {preferencesOpen && choice !== null ? (
          <button type="button" className="min-h-11 shrink-0 rounded-full px-3 font-bold text-moss underline underline-offset-4" onClick={() => setPreferencesOpen(false)}>
            Close
          </button>
        ) : null}
      </div>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-end">
        {dnt ? (
          choice === "granted" ? (
            <button type="button" className="min-h-11 rounded-full border border-line px-5 font-extrabold text-ink" onClick={() => choose("denied")}>
              Turn analytics off
            </button>
          ) : (
            <button type="button" className="min-h-11 rounded-full border border-line px-5 font-extrabold text-ink" onClick={() => setPreferencesOpen(false)}>
              Close
            </button>
          )
        ) : choice === "granted" ? (
          <>
            <button type="button" className="min-h-11 rounded-full border border-line px-5 font-extrabold text-ink" onClick={() => choose("denied")}>
              Turn analytics off
            </button>
            <button type="button" className="min-h-11 rounded-full bg-moss px-5 font-extrabold text-white" onClick={() => choose("granted")}>
              Keep analytics on
            </button>
          </>
        ) : choice === "denied" ? (
          <>
            <button type="button" className="min-h-11 rounded-full border border-line px-5 font-extrabold text-ink" onClick={() => choose("denied")}>
              Keep analytics off
            </button>
            <button type="button" className="min-h-11 rounded-full bg-moss px-5 font-extrabold text-white" onClick={() => choose("granted")}>
              Allow analytics
            </button>
          </>
        ) : (
          <>
            <button type="button" className="min-h-11 rounded-full border border-line px-5 font-extrabold text-ink" onClick={() => choose("denied")}>
              Reject analytics
            </button>
            <button type="button" className="min-h-11 rounded-full bg-moss px-5 font-extrabold text-white" onClick={() => choose("granted")}>
              Allow analytics
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** GA4 page views and its standard session events load only after opt-in on eligible public pages. */
export function ExperienceGa4Analytics({ measurementId }: { measurementId: string | null }) {
  useEffect(() => {
    if (!measurementId) stopGoogleTag();
  }, [measurementId]);

  if (!measurementId) return null;
  return <Suspense fallback={null}><AnalyticsConsentAndPageMeasurement measurementId={measurementId} /></Suspense>;
}
