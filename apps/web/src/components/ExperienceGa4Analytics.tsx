"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { doNotTrackEnabled, isPrivateLandingPath, sanitizeUmamiPayload } from "@/lib/analytics";
import { createGtagQueue, type GtagCommand } from "@/lib/ga4-queue";

const EXPERIENCE_ORIGIN = "https://experience.niho.life";
const GA4_SCRIPT_ID = "niho-experience-ga4-tracker";
const MEASUREMENT_ID = /^G-[A-Za-z0-9]{4,24}$/;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: GtagCommand;
    __nihoGa4MeasurementId?: string;
  }
}

type SafePageView = Readonly<{ location: string; title: string }>;

function safePageView(rawUrl: string): SafePageView | null {
  if (window.location.origin !== EXPERIENCE_ORIGIN || isPrivateLandingPath(window.location.pathname)) return null;
  const payload = sanitizeUmamiPayload("pageview", { url: rawUrl }, window.location.origin);
  if (!payload || typeof payload.url !== "string" || typeof payload.title !== "string") return null;
  return { location: `${EXPERIENCE_ORIGIN}${payload.url}`, title: payload.title };
}

function safeReferrer(): string {
  try {
    const referrer = new URL(document.referrer);
    return referrer.protocol === "https:" || referrer.protocol === "http:" ? referrer.origin : "";
  } catch {
    return "";
  }
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
  if (window.__nihoGa4MeasurementId !== measurementId) {
    window.__nihoGa4MeasurementId = measurementId;
    gtag("js", new Date());
    gtag("config", measurementId, {
      send_page_view: false,
      page_location: page.location,
      page_title: page.title,
      page_referrer: pageReferrer,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });

    const script = document.createElement("script");
    script.id = GA4_SCRIPT_ID;
    script.async = true;
    script.dataset.measurementId = measurementId;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(script);
  }
  return true;
}

function PageMeasurement({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const lastLocation = useRef<string | null>(null);

  useEffect(() => {
    if (!MEASUREMENT_ID.test(measurementId) || doNotTrackEnabled(navigator.doNotTrack)) return;
    const rawUrl = `${pathname}${search ? `?${search}` : ""}`;
    const page = safePageView(rawUrl);
    if (!page || lastLocation.current === page.location || doNotTrackEnabled(navigator.doNotTrack)) return;

    const pageReferrer = lastLocation.current ?? safeReferrer();
    if (!installGoogleTag(measurementId, page, pageReferrer) || !window.gtag || doNotTrackEnabled(navigator.doNotTrack)) return;

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
  }, [measurementId, pathname, search]);

  return null;
}

/** GA4 pageviews only; no client-side customer, booking, or funnel properties. */
export function ExperienceGa4Analytics({ measurementId }: { measurementId: string | null }) {
  if (!measurementId) return null;
  return <Suspense fallback={null}><PageMeasurement measurementId={measurementId} /></Suspense>;
}
