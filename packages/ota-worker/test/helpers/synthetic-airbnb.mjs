import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { AIRBNB_READ_HASHES, opaqueAirbnbId } from "../../src/airbnb-protocol.mjs";
import { CHROME } from "./synthetic-gyg.mjs";

const apiPath = (operation, variables) => {
  const hash = AIRBNB_READ_HASHES[operation];
  const query = new URLSearchParams({ operationName: operation, locale: "ja", currency: "JPY", variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }) });
  return `/api/v3/${operation}/${hash}?${query}`;
};

export async function syntheticAirbnb() {
  const state = {
    accountId: "900719925474099312345678901234567890", productId: "900719925474099398765432109876543210",
    authenticated: true, reportedAccountId: null, isAvailable: true, remainingCapacity: 8,
    profileReads: 0, calendarReads: 0, serverWrites: 0, maliciousPost: false, oversized: false, stopResult: true,
    hangProfileBody: false,
  };
  const calendarVariables = { startsAt: "2098-12-20T00:00:00.000Z", endsAt: "2099-01-31T00:00:00.000Z",
    listingIds: [], filters: [], filterByCoHostIds: [] };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET") {
      state.serverWrites += 1; response.writeHead(500); response.end(); return;
    }
    if (url.pathname === "/users/profile/about" && url.search === "?context=host") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (!state.authenticated) { response.end("<main><h1>ログイン</h1></main>"); return; }
      const profileVariables = { userId: opaqueAirbnbId("User", state.accountId), mockIdentifier: null, userProfileType: "HOST", isEditMode: true };
      const auxiliary = new URL(apiPath("IsHostQuery", {}), "http://fixture.invalid"); auxiliary.searchParams.delete("variables");
      response.end(`<!doctype html><html><body><main><h1>自己紹介</h1><button id="edit">編集</button></main><script>
        fetch(${JSON.stringify(auxiliary.pathname + auxiliary.search)}).then(response=>response.json()).catch(()=>{});
        fetch('/api/v2/client_configs',{method:'POST',body:'{}'}).catch(()=>{});
        fetch('/api/v2/get_travel_guides_by_user?user_id=synthetic').catch(()=>{});
        document.getElementById('edit').onclick=()=>{
          history.pushState({},'', '/users/profile/about?context=host&editMode=true');
          fetch(${JSON.stringify(apiPath("UserProfileQuery", profileVariables))}).then(response=>response.json()).catch(()=>{});
          if(${JSON.stringify(state.maliciousPost)})fetch('/business/save',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{});
        };
      </script></body></html>`); return;
    }
    if (/^\/multicalendar\/experiences-and-services\/\d{4}-\d{2}-\d{2}\/week$/.test(url.pathname)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><html><body><main><h1>Calendar</h1></main><script>
        fetch(${JSON.stringify(apiPath("XSCalendarEventsQuery", calendarVariables))}).then(response=>response.json()).catch(()=>{});
      </script></body></html>`); return;
    }
    const match = /^\/api\/v3\/([A-Za-z][A-Za-z0-9_]*)\/([a-f0-9]{64})$/.exec(url.pathname);
    if (match?.[1] === "IsHostQuery") {
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":{"isHost":true}}'); return;
    }
    if (match?.[1] === "UserProfileQuery") {
      state.profileReads += 1;
      const reported = state.reportedAccountId ?? state.accountId;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (state.hangProfileBody) { response.write('{"data":'); return; }
      response.end(JSON.stringify({ data: { node: { __typename: "User", id: opaqueAirbnbId("User", reported),
        owner: { __typename: "ContextualUser", id: "synthetic-owner", isViewerProfileOwner: true, privateData: "discard" } } } })); return;
    }
    if (match?.[1] === "XSCalendarEventsQuery") {
      state.calendarReads += 1;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (state.oversized) { response.end(JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) })); return; }
      const rows = [];
      for (let index = 0; index < 36; index += 1) {
        const startsAt = index === 0 ? "2099-01-01T04:00:00.000Z" : new Date(Date.UTC(2099, 0, 2, index)).toISOString();
        const endsAt = index === 0 ? "2099-01-01T05:00:00.000Z" : new Date(Date.parse(startsAt) + 3_600_000).toISOString();
        rows.push({
          __typename: "ExperienceCalendarItem", id: `target-${index}`, calendarEventId: `target-event-${index}`,
          listingId: opaqueAirbnbId("ActivityListing", state.productId), itemType: "calendarInstance", productType: "EXPERIENCE",
          startsAt, endsAt, isAvailable: index === 0 ? state.isAvailable : false,
          isVisible: true, remainingCapacity: index === 0 ? state.remainingCapacity : 0,
          shareLink: `https://www.airbnb.com/book/experiences/${state.productId}?availabilityKey=synthetic`,
          numGuests: 999, privateTitle: "discard",
        });
        if (index < 5) rows.push({
          __typename: "ExperienceCalendarItem", id: `other-${index}`, calendarEventId: `other-event-${index}`,
          listingId: opaqueAirbnbId("ActivityListing", "7"), itemType: "calendarInstance", productType: "EXPERIENCE",
          startsAt, endsAt, isAvailable: true, isVisible: true, remainingCapacity: 1,
          shareLink: "https://www.airbnb.jp/book/experiences/7", privateTitle: "discard other listing",
        });
        if (index < 5) rows.push({
          __typename: "PrivateCalendarItem", id: `private-${index}`, itemType: "privateCalendar",
          startsAt, endsAt, numGuests: 500, privateTitle: "discard private calendar",
        });
      }
      response.end(JSON.stringify({ data: { presentation: { activityHostCalendarContainer: { iCalendarItemsConnection: rows } } } })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const privateDir = await mkdtemp(join(tmpdir(), "niho-airbnb-browser-"));
  const profiles = join(privateDir, "profiles"); const namespace = join(profiles, "airbnb"); const profile = join(namespace, state.accountId);
  await mkdir(profiles, { mode: 0o700 }); await mkdir(namespace, { mode: 0o700 }); await mkdir(profile, { mode: 0o700 });
  let browser;
  try { browser = await chromium.launch({ executablePath: CHROME, headless: true }); }
  catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  const browserFactory = async () => {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    let stopped = false;
    return Object.freeze({ pid: process.pid, context, async stop() {
      if (!stopped) { stopped = true; await context.close().catch(() => {}); }
      return state.stopResult;
    } });
  };
  const config = { privateDir, accountProfiles: {}, siteAccountProfiles: { Airbnb: { [state.accountId]: profile } },
    browserExecutable: CHROME, mode: "deterministic", debugScreenshots: false };
  const makeJob = (overrides = {}) => {
    const current = Date.now();
    return Object.freeze({
      id: randomUUID(), leaseToken: "lease", leaseExpiresAtUtc: new Date(current + 120_000).toISOString(),
      deadlineAtUtc: new Date(current + 180_000).toISOString(), action: "OBSERVE", occurrenceId: "synthetic-occurrence",
      desiredVersion: 1, mappingVersion: 1, sourceStartAtUtc: "2099-01-01T04:00:00.000Z", sourceEndAtUtc: "2099-01-01T05:00:00.000Z",
      target: Object.freeze({ site: "Airbnb", externalAccountId: state.accountId, externalProductId: state.productId, externalOptionId: "",
        timeZone: "Asia/Tokyo", adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE" }),
      ...overrides,
    });
  };
  return { state, origin, config, browserFactory, makeJob, async close() {
    await browser.close().catch(() => {}); await new Promise((resolve) => server.close(resolve));
  } };
}
