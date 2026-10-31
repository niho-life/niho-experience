"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, type ComponentProps } from "react";
import { doNotTrackEnabled, FUNNEL_EVENTS, sanitizeUmamiPayload, setAnalyticsSink, shouldStartUmami, track, type EventProps, type FunnelEvent, type TrackedEvent } from "@/lib/analytics";

interface UmamiTracker {
  track: {
    (): Promise<void>;
    (name: string, data?: Record<string, string | number | boolean>): Promise<void>;
    (buildPayload: (props: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
  };
}

declare global {
  interface Window {
    umami?: UmamiTracker;
    nihoUmamiBeforeSend?: (type: string, payload: Record<string, unknown>) => Record<string, unknown> | false;
  }
}

const pendingUmamiEvents: { event: TrackedEvent; url: string }[] = [];
const pendingUmamiPageViews: string[] = [];

const UMAMI_TRACKER_SNAPSHOT = {
  // SHA-384 of cloud.umami.is/script.js captured on 2026-10-19. Keep this
  // pinned so a changed third-party response cannot execute without review.
  integrity: "sha384-na2rtfGcck2U+oedd3Fj+22SUyB41DM4F/gLssqYa9ELN6oF1aJzA2p80zu7Vy6a",
};

function flushUmamiEvents() {
  if (doNotTrackEnabled(navigator.doNotTrack)) {
    pendingUmamiEvents.length = 0;
    pendingUmamiPageViews.length = 0;
    return;
  }
  const tracker = window.umami;
  if (!tracker?.track) return;
  for (const pageUrl of pendingUmamiPageViews.splice(0)) {
    try {
      void tracker.track((props) => ({ ...props, url: pageUrl })).catch(() => undefined);
    } catch {
      // Analytics must not affect the guest.
    }
  }
  for (const { event, url } of pendingUmamiEvents.splice(0)) {
    try {
      void tracker.track((props) => ({ ...props, name: event.event, data: event.props, url })).catch(() => undefined);
    } catch {
      // Analytics must not affect the guest.
    }
  }
}

function trackUmamiPageView(pageUrl: string) {
  if (doNotTrackEnabled(navigator.doNotTrack)) return;
  const tracker = window.umami;
  if (tracker?.track) {
    try {
      void tracker.track((props) => ({ ...props, url: pageUrl })).catch(() => undefined);
    } catch {
      // Analytics must not affect the guest.
    }
  } else if (pendingUmamiPageViews.length < 100) {
    pendingUmamiPageViews.push(pageUrl);
  }
}

/** Track only pageviews and the allowlisted funnel events; click tracking is disabled. */
function UmamiPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const lastPageKey = useRef<string | null>(null);

  useEffect(() => {
    const rawUrl = `${pathname}${search ? `?${search}` : ""}`;
    const sanitized = sanitizeUmamiPayload("pageview", { url: rawUrl }, window.location.origin);
    const pageKey = sanitized && typeof sanitized.url === "string" ? sanitized.url : null;
    if (!pageKey || lastPageKey.current === pageKey) return;
    lastPageKey.current = pageKey;
    trackUmamiPageView(pageKey);
  }, [pathname, search]);

  return null;
}

/**
 * Preview keeps events in memory for review. Umami is enabled only by the
 * production layout when its canonical host and runtime website ID are set.
 */
export function AnalyticsSetup({ mode, websiteId }: { mode: "debug" | "off" | "umami"; websiteId: string }) {
  useEffect(() => {
    if (mode === "off") {
      setAnalyticsSink(null);
      return;
    }

    if (mode === "debug") {
      window.__nihoEvents = [];
      setAnalyticsSink((event) => {
        window.__nihoEvents?.push(event);
        console.debug("[funnel]", event.event, event.props);
      });
      return () => setAnalyticsSink(null);
    }

    if (!shouldStartUmami(websiteId, navigator.doNotTrack, window.location.pathname)) {
      setAnalyticsSink(null);
      return;
    }

    // Umami calls this hook before sending pageviews or events. Define it
    // before adding the external script so no unfiltered payload can race it.
    window.nihoUmamiBeforeSend = (type, payload) => {
      if (doNotTrackEnabled(navigator.doNotTrack)) return false;
      if (type === "event") {
        if (payload.name !== undefined && (typeof payload.name !== "string" || !Object.hasOwn(FUNNEL_EVENTS, payload.name))) return false;
      } else if (type !== "pageview") {
        return false;
      }
      return sanitizeUmamiPayload(type, payload, window.location.origin);
    };

    setAnalyticsSink((event) => {
      if (doNotTrackEnabled(navigator.doNotTrack)) return;
      const payload = sanitizeUmamiPayload("event", { url: window.location.href, name: event.event, data: event.props }, window.location.origin);
      if (!payload || typeof payload.url !== "string") return;
      const url = payload.url;
      if (window.umami?.track) {
        try {
          void window.umami.track((props) => ({ ...props, name: event.event, data: event.props, url })).catch(() => undefined);
        } catch {
          // Analytics must not affect the guest.
        }
      } else if (pendingUmamiEvents.length < 100) {
        pendingUmamiEvents.push({ event, url });
      }
    });

    let script = document.getElementById("niho-umami-tracker") as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = "niho-umami-tracker";
      script.defer = true;
      script.src = "https://cloud.umami.is/script.js";
      script.integrity = UMAMI_TRACKER_SNAPSHOT.integrity;
      script.crossOrigin = "anonymous";
      script.dataset.websiteId = websiteId;
      script.dataset.hostUrl = "https://gateway.umami.is";
      script.dataset.domains = "experience.niho.life";
      // Disable automatic click collection; this app sends pageviews and
      // explicitly allowlisted funnel events only.
      script.dataset.autoTrack = "false";
      script.dataset.doNotTrack = "true";
      script.dataset.excludeHash = "true";
      script.dataset.beforeSend = "nihoUmamiBeforeSend";
      script.addEventListener("load", flushUmamiEvents, { once: true });
      document.head.appendChild(script);
    } else if (window.umami?.track) {
      flushUmamiEvents();
    } else {
      script.addEventListener("load", flushUmamiEvents, { once: true });
    }

    return () => setAnalyticsSink(null);
  }, [mode, websiteId]);
  return mode === "umami" ? <Suspense fallback={null}><UmamiPageView /></Suspense> : null;
}

/** Records an event when the page is shown, and again only if its contents change (e.g. new filters). */
export function TrackView({ event, props }: { event: FunnelEvent; props?: EventProps }) {
  const lastSent = useRef<string | null>(null);
  const key = `${event}:${JSON.stringify(props ?? {})}`;
  useEffect(() => {
    if (lastSent.current === key) return;
    lastSent.current = key;
    // Let AnalyticsSetup register its sink first.
    queueMicrotask(() => track(event, props));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers `props`
  }, [event, key]);
  return null;
}

export function TrackedLink({ event, props, onClick, ...rest }: ComponentProps<typeof Link> & { event: FunnelEvent; props?: EventProps }) {
  return (
    <Link
      {...rest}
      onClick={(e) => {
        track(event, props);
        onClick?.(e);
      }}
    />
  );
}
