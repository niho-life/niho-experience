import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { EXPECTED_MUTATION } from "../../src/constants.mjs";
import { createServer } from "node:http";

export const CHROME = process.env.OTA_TEST_CHROME_EXECUTABLE
  ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chromium.executablePath());

export async function syntheticGyg() {
  const state = {
    accountId: "10001",
    productId: "20002",
    optionId: "30003",
    localDateTime: "2099-01-01T13:00:00",
    blocked: false,
    bookableWhenOpen: true,
    authenticated: true,
    failAfterSave: false,
    writes: 0,
    requestBodies: [],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!state.authenticated && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>Sign in</h1>"); return;
    }
    if (url.pathname === "/company-profile/company-details" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(`<p><span>Supplier ID:</span> ${state.accountId}</p>`); return;
    }
    if (url.pathname === "/manage/availability" && request.method === "GET") {
      const checked = state.blocked ? "checked" : "";
      const bookable = !state.blocked && state.bookableWhenOpen ? "<span>Bookable</span>" : "<span>Not Bookable</span>";
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<!doctype html><html><body><article>
        <a href="/products/details?tour_id=${state.productId}">Synthetic product</a>
        <input type="checkbox" role="switch" data-testid="toggle-accept-bookings-${state.optionId}-${state.localDateTime}" aria-checked="${state.blocked}" ${checked}>
        ${bookable}
        <script>
          const toggle=document.querySelector('[role=switch]');
          toggle.addEventListener('click',async()=>{
            const desired=toggle.checked;
            try {
              const response=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationName:'UpdateMultipleTimeSlots',query:${JSON.stringify(EXPECTED_MUTATION)},variables:{input:{isBlocked:desired,type:'IS_BLOCKED',timeSlots:[{dateTime:${JSON.stringify(state.localDateTime.slice(0, 16))},tourOptionId:${JSON.stringify(state.optionId)}}]}}})});
              if(response.ok){const value=await response.json();toggle.checked=value.blocked;toggle.setAttribute('aria-checked',String(value.blocked));}
            } catch {}
          });
        </script>
      </article></body></html>`); return;
    }
    if (url.pathname === "/graphql" && request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); state.requestBodies.push(body);
      if (body.operationName === "SyntheticRead") {
        response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":{"ok":true}}'); return;
      }
      const slot = body.variables?.input?.timeSlots?.[0];
      if (body.operationName !== "UpdateMultipleTimeSlots" || slot?.tourOptionId !== state.optionId) {
        response.writeHead(403); response.end(); return;
      }
      state.blocked = body.variables.input.isBlocked; state.writes += 1;
      if (state.failAfterSave) { state.failAfterSave = false; request.socket.destroy(); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ blocked: state.blocked })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const privateDir = await mkdtemp(join(tmpdir(), "niho-ota-test-"));
  const profilesDir = join(privateDir, "profiles"); await mkdir(profilesDir, { mode: 0o700 });
  const profile = join(profilesDir, state.accountId); await mkdir(profile, { mode: 0o700 });
  let browser;
  try { browser = await chromium.launch({ executablePath: CHROME, headless: true }); }
  catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  const browserFactory = async () => {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    return { pid: process.pid, context, async stop() { await context.close(); return true; } };
  };
  const config = {
    privateDir,
    accountProfiles: { [state.accountId]: profile },
    browserExecutable: CHROME,
    mode: "deterministic",
    debugScreenshots: false,
  };
  return {
    state, origin, privateDir, profile, config, browserFactory,
    async close() { await browser.close(); await new Promise((resolve) => server.close(resolve)); },
  };
}

export function makeJob(state, action, overrides = {}) {
  const now = Date.now();
  return Object.freeze({
    id: randomUUID(), leaseToken: "lease-token", leaseExpiresAtUtc: new Date(now + 120_000).toISOString(), deadlineAtUtc: new Date(now + 180_000).toISOString(),
    action, occurrenceId: "synthetic-occurrence", desiredVersion: 1, mappingVersion: 1,
    sourceStartAtUtc: "2099-01-01T04:00:00.000Z", sourceEndAtUtc: "2099-01-01T05:00:00.000Z",
    localDateTime: state.localDateTime,
    desiredState: action === "SET_CLOSED" ? "CLOSED" : action === "SET_OPEN" ? "OPEN" : undefined,
    target: Object.freeze({ site: "GetYourGuide", externalAccountId: state.accountId, externalProductId: state.productId,
      externalOptionId: state.optionId, timeZone: "Asia/Tokyo", adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER" }),
    ...overrides,
  });
}
