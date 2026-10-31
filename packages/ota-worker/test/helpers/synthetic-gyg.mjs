import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { EXPECTED_MUTATION } from "../../src/constants.mjs";
import { createServer } from "node:http";

export const CHROME = process.env.OTA_TEST_CHROME_EXECUTABLE
  ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chromium.executablePath());

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const UTC_DAY_TO_WEEKDAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const SYNTHETIC_STEP_MUTATION = "mutation SupplierPortalUpdateScheduleStep($scheduleId: Int!, $input: SyntheticScheduleStepInput!) { updateScheduleStep(scheduleId: $scheduleId, input: $input) { success message errorDetails { field message } } }";

// Synthetic GYG option schedule (AvailabilityBlock). Setting state.schedule
// switches the availability agenda to rows generated from it.
export function syntheticSchedule(overrides = {}) {
  return {
    optionStatus: "ACTIVE",
    timezone: "Asia/Tokyo",
    availabilityType: "starting_times",
    pricing: [{ status: "ACTIVE", blocks: [syntheticBlock()] }],
    otherOptionId: "30004",
    ...overrides,
  };
}

export function syntheticBlock(overrides = {}) {
  return {
    id: 7001,
    name: "Synthetic weekday schedule",
    validity: { start: "2098-12-01", end: null },
    weekdays: Object.fromEntries(WEEKDAYS.map((day) => [day, day === "saturday" || day === "sunday" ? [] : ["09:00"]])),
    specialDates: [{ date: "2099-01-05", times: ["15:00"] }],
    ...overrides,
  };
}

const weekdayOf = (date) => UTC_DAY_TO_WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
const slotsOf = (times) => times.map((from) => ({ from, to: null }));

function blockJson(block) {
  return {
    id: block.id,
    name: block.name,
    validityDateRange: { start: block.validity.start, end: block.validity.end },
    weekdays: WEEKDAYS.map((day) => ({ day, timeSlots: slotsOf(block.weekdays[day] ?? []) })),
    specialDates: block.specialDates.map((entry) => ({ date: entry.date, timeSlots: slotsOf(entry.times) })),
  };
}

// The screen's own step-1 variables for a block as loaded into the editor.
function stepInput(block) {
  return {
    name: block.name,
    dateRange: block.validity.end === null ? { start: block.validity.start } : { start: block.validity.start, end: block.validity.end },
    weekdays: WEEKDAYS.map((day) => ({ day, timeSlots: slotsOf(block.weekdays[day] ?? []) })),
    specialDates: block.specialDates.map((entry) => ({ date: entry.date, timeSlots: slotsOf(entry.times) })),
  };
}

// Occurrence times the synthetic agenda lists for one date (special dates
// replace the weekday times in this fixture).
function agendaTimes(schedule, date) {
  if (schedule.optionStatus !== "ACTIVE" || schedule.agendaHidden) return [];
  const times = new Set();
  for (const entry of schedule.pricing) {
    if (entry.status !== "ACTIVE") continue;
    for (const block of entry.blocks) {
      if (date < block.validity.start || (block.validity.end !== null && date > block.validity.end)) continue;
      const special = block.specialDates.find((item) => item.date === date);
      for (const time of special ? special.times : block.weekdays[weekdayOf(date)] ?? []) times.add(time);
    }
  }
  return [...times].sort();
}

export async function syntheticGyg() {
  const state = {
    accountId: "10001",
    productId: "20002",
    optionId: "30003",
    localDateTime: "2099-01-01T13:00:00",
    blocked: false,
    bookableWhenOpen: true,
    authenticated: true,
    responseFailure: null,
    rawDeliveries: 0,
    logicalStateTransitions: 0,
    uiActions: 0,
    requestBodies: [],
    bookings: [],
    reservationStatus: 200,
    reservationRequests: [],
    unexpectedWrites: 0,
    schedule: null,
    scheduleReads: 0,
    scheduleReadClients: [],
    scheduleMutations: 0,
    scheduleMutationVariables: [],
    scheduleResponse: "success",
    screenTamper: null,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!state.authenticated && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>Sign in</h1>"); return;
    }
    if (url.pathname === "/company-profile/company-details" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(`<p><span>Supplier ID:</span> ${state.accountId}</p>`); return;
    }
    if (url.pathname === "/bookings" && request.method === "GET") {
      // The synthetic supplier app sends a side mutation first, then its own
      // bookings read carrying the session headers the reader must reuse.
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<!doctype html><html><body><h1>Bookings</h1><script>
        (async () => {
          const post = (headers, payload) => fetch('/graphql', { method: 'POST',
            headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) }).catch(() => null);
          await post({}, { operationName: 'SyntheticMarkSeen', query: 'mutation SyntheticMarkSeen { markSeen { ok } }', variables: {} });
          await post({ authorization: 'Bearer synthetic-session-token', 'x-synthetic-client': 'supplier-portal' },
            { operationName: 'SyntheticBookingsList', query: 'query SyntheticBookingsList { bookings { id } }', variables: {} });
        })();
      </script></body></html>`); return;
    }
    if (url.pathname === "/manage/availability" && request.method === "GET" && state.schedule) {
      // The synthetic supplier app loads the agenda through its own read query
      // (carrying the session headers) and renders rows only after it returns.
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<!doctype html><html><body><main id="agenda"><h1>Availability</h1></main><script>
        (async () => {
          const response = await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json',
            authorization: 'Bearer synthetic-session-token', 'x-synthetic-client': 'supplier-portal' },
            body: JSON.stringify({ operationName: 'SyntheticAgendaRead', query: 'query SyntheticAgendaRead { agenda { rows } }',
              variables: { date: ${JSON.stringify(url.searchParams.get("filter_date_from"))} } }) });
          const value = await response.json();
          for (const row of value.data.agenda.rows) {
            const article = document.createElement('article');
            const link = document.createElement('a'); link.href = '/products/details?tour_id=' + row.productId; link.textContent = 'Synthetic product';
            const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch');
            toggle.dataset.testid = row.testId; toggle.setAttribute('aria-checked', 'false');
            const bookable = document.createElement('span'); bookable.textContent = 'Bookable';
            article.append(link, toggle, bookable);
            document.getElementById('agenda').append(article);
          }
        })();
      </script></body></html>`); return;
    }
    if (url.pathname === "/products/details" && request.method === "GET" && state.schedule) {
      if (url.searchParams.get("tour_id") !== state.productId) { response.writeHead(404); response.end(); return; }
      const block = state.schedule.pricing.flatMap((entry) => entry.blocks)[0];
      const ours = block ? stepInput(block) : null;
      if (ours && state.screenTamper) state.screenTamper(ours);
      const screens = {
        [state.optionId]: block ? [{ id: block.id, name: block.name, input: ours }] : [],
        [state.schedule.otherOptionId]: [{ id: 7999, name: "Other option schedule", input: stepInput({ ...syntheticBlock(), name: "Other option schedule" }) }],
      };
      const option = (id) => `<section class="option">
          <div class="split"><button data-testid="product-option-edit-button-${id}">Edit option</button><button data-testid="product-option-edit-button-${id}" aria-label="More actions">v</button></div>
          <button class="toggle" data-option="${id}">Show schedules</button>
          <div class="schedules" data-option="${id}"></div>
        </section>`;
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<!doctype html><html><body><main>
        <h1>Synthetic product</h1>
        ${option(state.optionId)}
        ${option(state.schedule.otherOptionId)}
        <span style="display:none">${block?.name ?? ""}</span>
        <div id="editor"></div>
      </main><script>
        const screens = ${JSON.stringify(screens)};
        const stepMutation = ${JSON.stringify(SYNTHETIC_STEP_MUTATION)};
        const post = (payload) => fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        post({ operationName: 'Inbox_UnreadCountChanged', query: 'subscription Inbox_UnreadCountChanged { inbox { unread } }', variables: {} }).catch(() => {});
        fetch('https://supplier-public.invalid/graphql', { method: 'POST', body: '{}' }).catch(() => {});
        for (const toggle of document.querySelectorAll('.toggle')) {
          toggle.addEventListener('click', () => {
            const list = document.querySelector('.schedules[data-option="' + toggle.dataset.option + '"]');
            if (toggle.textContent === 'Hide schedules') { list.replaceChildren(); toggle.textContent = 'Show schedules'; return; }
            toggle.textContent = 'Hide schedules';
            for (const schedule of screens[toggle.dataset.option]) {
              const row = document.createElement('div'); row.className = 'schedule-row';
              const name = document.createElement('span'); name.textContent = schedule.name;
              const tip = document.createElement('span'); tip.style.display = 'none'; tip.textContent = schedule.name;
              const pen = document.createElement('button'); pen.innerHTML = '<i class="icon i-pen-edit"></i>';
              const copy = document.createElement('button'); copy.textContent = 'Duplicate';
              pen.addEventListener('click', () => openEditor(schedule));
              row.append(name, tip, pen, copy);
              list.append(row);
            }
          });
        }
        function openEditor(schedule) {
          const editor = document.getElementById('editor');
          editor.innerHTML = '<h2>Edit schedule</h2><button data-testid="stepper-save-and-continue">Save and continue</button>';
          editor.querySelector('button').addEventListener('click', async () => {
            post({ operationName: 'Inbox_UnreadCountChanged', query: 'subscription Inbox_UnreadCountChanged { inbox { unread } }', variables: {} }).catch(() => {});
            try {
              const response = await post({ operationName: 'SupplierPortalUpdateScheduleStep', query: stepMutation,
                variables: { scheduleId: schedule.id, input: schedule.input } });
              const value = await response.json();
              if (value.data?.updateScheduleStep?.success) {
                editor.innerHTML = '<h2>Pricing</h2>';
                addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = ''; });
              }
            } catch {}
          });
        }
      </script></body></html>`); return;
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
            await globalThis.__nihoRecordSyntheticClick();
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
      if (body.operationName === "SyntheticBookingsList") {
        response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":{"bookings":[]}}'); return;
      }
      if (body.operationName === "NihoReservationWindowRead") {
        const input = body.variables?.input ?? {};
        state.reservationRequests.push({ authorization: request.headers.authorization ?? null, client: request.headers["x-synthetic-client"] ?? null, input });
        if (state.reservationStatus !== 200 || request.headers.authorization !== "Bearer synthetic-session-token") {
          response.writeHead(state.reservationStatus === 200 ? 401 : state.reservationStatus); response.end(); return;
        }
        const items = state.bookings.slice(input.offset, input.offset + input.limit);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { bookings: { items, pagination: { totalItems: state.bookings.length } } } })); return;
      }
      if (body.operationName === "SyntheticAgendaRead" && state.schedule) {
        const date = body.variables?.date;
        const rows = agendaTimes(state.schedule, date).map((time) => ({
          productId: state.productId, testId: `toggle-accept-bookings-${state.optionId}-${date}T${time}:00`,
        }));
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: { agenda: { rows } } })); return;
      }
      if (body.operationName === "NihoEnsureScheduleRead" && state.schedule) {
        state.scheduleReads += 1;
        state.scheduleReadClients.push(request.headers["x-synthetic-client"] ?? null);
        if (request.headers.authorization !== "Bearer synthetic-session-token") { response.writeHead(401); response.end(); return; }
        // Mirrors the live contract: an ID! variable carrying the option id string.
        if (body.variables?.id !== state.optionId || !/\(\$id: ID!\)/.test(String(body.query))) {
          response.writeHead(200, { "content-type": "application/json" }); response.end('{"errors":[{"message":"synthetic"}]}'); return;
        }
        const schedule = state.schedule;
        const activityOption = {
          id: Number(state.optionId), status: schedule.optionStatus, timezone: schedule.timezone,
          inventoryConfiguration: { availabilityType: schedule.availabilityType },
          availabilityAndPricing: schedule.pricing.map((entry) => ({ status: entry.status, availabilityBlock: entry.blocks.map(blockJson) })),
        };
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: { activityOption } })); return;
      }
      if (body.operationName === "SupplierPortalUpdateScheduleStep" && state.schedule) {
        state.scheduleMutations += 1;
        state.scheduleMutationVariables.push(body.variables);
        const block = state.schedule.pricing.flatMap((entry) => entry.blocks).find((item) => String(item.id) === String(body.variables?.scheduleId));
        if (!block || state.scheduleResponse === "success-false") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { updateScheduleStep: { success: false, message: "Synthetic validation failure", errorDetails: [] } } })); return;
        }
        const input = body.variables.input;
        block.name = input.name;
        block.validity = { start: input.dateRange.start, end: input.dateRange.end ?? null };
        block.weekdays = Object.fromEntries(input.weekdays.map((entry) => [entry.day, entry.timeSlots.map((slot) => slot.from)]));
        block.specialDates = input.specialDates.map((entry) => ({ date: entry.date, times: entry.timeSlots.map((slot) => slot.from) }));
        if (state.scheduleResponse === "lost") {
          response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
          response.write('{"data":');
          setTimeout(() => response.destroy(), 10);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { updateScheduleStep: { success: true, message: null, errorDetails: [] } } })); return;
      }
      if (body.operationName === "SyntheticMarkSeen") state.unexpectedWrites += 1;
      if (body.operationName === "SyntheticRead") {
        response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":{"ok":true}}'); return;
      }
      const slot = body.variables?.input?.timeSlots?.[0];
      if (body.operationName !== "UpdateMultipleTimeSlots" || slot?.tourOptionId !== state.optionId) {
        response.writeHead(403); response.end(); return;
      }
      const desired = body.variables.input.isBlocked;
      if (state.blocked !== desired) state.logicalStateTransitions += 1;
      state.blocked = desired; state.rawDeliveries += 1;
      if (state.responseFailure === "before-headers") { request.socket.destroy(); return; }
      if (state.responseFailure === "after-headers") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        response.write('{"blocked":');
        setTimeout(() => response.destroy(), 10);
        return;
      }
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
    await context.exposeFunction("__nihoRecordSyntheticClick", () => { state.uiActions += 1; });
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
    desiredState: action === "SET_CLOSED" ? "CLOSED" : action === "SET_OPEN" || action === "ENSURE_OCCURRENCE" ? "OPEN" : undefined,
    target: Object.freeze({ site: "GetYourGuide", externalAccountId: state.accountId, externalProductId: state.productId,
      externalOptionId: state.optionId, timeZone: "Asia/Tokyo", adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER" }),
    ...overrides,
  });
}
