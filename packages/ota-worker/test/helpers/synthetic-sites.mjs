import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { makeJob } from "./synthetic-gyg.mjs";

export const CHROME = process.env.OTA_TEST_CHROME_EXECUTABLE
  ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chromium.executablePath());

const readBody = async (request) => { let raw = ""; for await (const chunk of request) raw += chunk; return JSON.parse(raw); };

async function fixtureBase(prefix, state, handler, site, namespace) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const privateDir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const profiles = join(privateDir, "profiles"); await mkdir(profiles, { mode: 0o700 });
  const namespaceDir = join(profiles, namespace); await mkdir(namespaceDir, { mode: 0o700 });
  const profile = join(namespaceDir, state.accountId); await mkdir(profile, { mode: 0o700 });
  let browser;
  try { browser = await chromium.launch({ executablePath: CHROME, headless: true }); }
  catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  const browserFactory = async () => {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    return { pid: process.pid, context, async stop() { await context.close(); return true; } };
  };
  return { state, origin, config: { privateDir, accountProfiles: {}, siteAccountProfiles: { [site]: { [state.accountId]: profile } },
    browserExecutable: CHROME, mode: "deterministic", debugScreenshots: false }, browserFactory,
    async close() { await browser.close(); await new Promise((resolve) => server.close(resolve)); } };
}

export async function syntheticViator() {
  const state = { accountId: "999999", productId: "999999P1", optionId: "TG1", localDateTime: "2099-01-01T13:00:00",
    initialDate: "2098-12-19", availability: "AVAILABLE", authenticated: true, responseFailure: null, writes: 0, requests: [], reads: [] };
  const handler = async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/availability/" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (!state.authenticated) { response.end("<h1>Log in</h1>"); return; }
      response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><button>Synthetic product（${state.accountId}）</button>
        <input placeholder="日付を選択" readonly style="display:none"><input placeholder="日付を選択" readonly value="${state.initialDate}"><div id="picker"></div><div id="grid"></div>
        <script>
          const input=document.querySelectorAll('input')[1];
          let month=new Date('${state.initialDate}T12:00:00Z');
          function drawPicker(){const picker=document.getElementById('picker');picker.replaceChildren();for(const [name,delta] of [['Go to the Previous Month',-1],['Go to the Next Month',1]]){const button=document.createElement('button');button.setAttribute('aria-label',name);button.onclick=()=>{month=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+delta,1,12));drawPicker()};picker.append(button)}const grid=document.createElement('table');grid.setAttribute('role','grid');grid.setAttribute('aria-label',new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(month));for(let n=1;n<=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)).getUTCDate();n++){const date=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth(),n,12));const button=document.createElement('button');button.setAttribute('aria-label',date.toDateString());button.onclick=()=>{input.value=date.toISOString().slice(0,10);picker.replaceChildren();load(input.value)};grid.append(button)}picker.append(grid)}
          input.onclick=drawPicker;
          const stateFor=(date)=>({startDate:${JSON.stringify(state.initialDate)},endDate:${JSON.stringify(state.initialDate)},jumpToDate:date,filteredProducts:[],filteredTourGrades:{},loadDirection:date===${JSON.stringify(state.initialDate)}?"FORWARD":"BIDIRECTIONAL",hasMoreAfter:false,hasMoreBefore:false,perDayPagination:{}});
          async function load(date){const listState=stateFor(date);const data=await (await fetch('/availability/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(listState)})).json();
            const row=data.availabilities[date]?.[0];const grid=document.getElementById('grid');grid.replaceChildren();if(!row)return;
            const container=document.createElement('div');container.className='synthetic_gridCol_observed';container.innerHTML='<a href="/bookings/search?travelDate='+date+'&filteredTourGrade='+row.productCode+'%7C'+row.tourGradeCode+'">予約を表示</a><span>13:00</span><span class="state">'+(row.availability==='AVAILABLE'?'予約可能':'完売')+'</span>';
            const action=document.createElement('button');action.textContent=row.availability==='AVAILABLE'?'完売':'予約可能';action.onclick=()=>fetch('/availability/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({availabilityKeys:[{productCode:row.productCode,tourGradeCode:row.tourGradeCode,travelDate:date,startTime:'13:00:00'}],availability:row.availability==='AVAILABLE'?'SOLD_OUT':'AVAILABLE',prevAvailability:row.availability,isBulkUpdate:false,availabilityListState:data.availabilityListState})});container.append(action);grid.append(container);}
          load(input.value);
        </script></body></html>`); return;
    }
    if (url.pathname === "/availability/api" && request.method === "POST") {
      const body = await readBody(request); state.reads.push(body);
      const target = body.jumpToDate === state.localDateTime.slice(0, 10);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ availabilities: { [body.jumpToDate]: target ? [{ productCode: state.productId, tourGradeCode: state.optionId,
        startTime: "13:00:00", availability: state.availability }] : [] }, availabilityListState: { ...body, perDayPagination: { [body.jumpToDate]: { cursor: 1, hasMore: false } } }, privateIdentity: { syntheticSecret: "discard" } })); return;
    }
    if (url.pathname === "/availability/update" && request.method === "POST") {
      const body = await readBody(request); state.requests.push(body); state.writes += 1; state.availability = body.availability;
      if (state.responseFailure === "drop") { request.socket.destroy(); return; }
      if (state.responseFailure === "500") { response.writeHead(500, { "content-type": "application/json" }); response.end('{"ok":false}'); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return;
    }
    response.writeHead(404); response.end();
  };
  const fixture = await fixtureBase("niho-viator-", state, handler, "Viator", "viator");
  return { ...fixture, makeJob(action, overrides = {}) { return makeJob(state, action, { target: Object.freeze({ site: "Viator", externalAccountId: state.accountId,
    externalProductId: state.productId, externalOptionId: state.optionId, timeZone: "Asia/Tokyo", adapter: "viator-browser", adapterVersion: "1", connectionMode: "BROWSER" }), ...overrides }); } };
}

export async function syntheticJalan() {
  const state = { accountId: "SyntheticAirId", productId: "l000000001", optionId: "1", slotId: "T_SYNTHETIC", initialSlotId: "T_BOOTSTRAP",
    initialDate: "2098-12-05", localDateTime: "2099-01-01T13:00:00", open: true, authenticated: true, responseFailure: null,
    writes: 0, requests: [], reads: [], renderDelayMs: 0 };
  const summary = (compactDate) => {
    const base = Date.UTC(Number(compactDate.slice(0, 4)), Number(compactDate.slice(4, 6)) - 1, Number(compactDate.slice(6, 8)));
    const dispDays = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(base + index * 86_400_000);
      return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    });
    const slots = dispDays.map((day) => {
      const date = String(day.year) + String(day.month).padStart(2, "0") + String(day.day).padStart(2, "0");
      const frontOpen = date === "20990101" ? state.open : true;
      return { slotId: date === "20990101" ? state.slotId : `T_SYNTHETIC_${date}`,
        receptionStatus: frontOpen ? "KeyOPEN" : "KeyCLOSE", frontOpenFlg: frontOpen,
        bookingAvailableKbn: "KeyUNCONFIRMED", cfmBookingLimMgrKbn: null, cfmCapaBookingCnt: 0, cfmCapaPaxCnt: 0,
        cfmEntryBookingCnt: 0, cfmEntryPaxCnt: 0, uncfmEntryBookingCnt: 0, uncfmEntryPaxCnt: 0, version: 1 };
    });
    return { dto: { dspBaseDate: compactDate, selectedLessonSchdlId: state.productId, dispDays,
      plans: [{ lessonSchdlId: state.productId, version: 21, tmzs: [{ timeZoneSeqNo: 1, startHm: "13:00", endHm: "14:00", slots }] }] },
      authCsrfDto: { syntheticSecret: "discard" } };
  };
  const handler = async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/activityboard/bookingStockMgt/" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (!state.authenticated) { response.end("<h1>ログイン</h1>"); return; }
      response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><header><ul><li>Account<ul><li>\n AirID \n ${state.accountId} \n</li></ul></li></ul></header>
        <input class="experienceDay" style="display:${state.renderDelayMs ? "none" : "block"}" value="${state.initialDate}"><input class="datepicker" style="display:none"><input class="js-groupCfmCapaCnt" style="display:none"><select><option value="${state.productId}" selected>Synthetic plan</option></select><h2>プランID ${state.productId}</h2>
        <div class="ui-datepicker" hidden><a href="#" data-handler="prev">&lt;前</a><a href="#" data-handler="next">次&gt;</a><span class="ui-datepicker-year"></span><span class="ui-datepicker-month"></span><table><tbody id="picker-days"></tbody></table></div>
        <span id="count">0/14</span><ul id="slots"></ul><select class="js-panel-saleStatus"><option>販売</option><option>売止</option></select>
        <button id="complete">一括変更する</button><a href="#" id="refresh">最新の情報に更新</a>
        <script>
          const input=document.querySelector('input');let callbackIndex=0;let selected=false;let currentDate=input.value.replaceAll('-','');
          async function load(compactDate){currentDate=compactDate;const callback='syntheticCallback'+(++callbackIndex);const query=new URLSearchParams({callback,dspBaseDate:callbackIndex===1?'':compactDate,dspRange:'14',pageSize:'0',pageNo:'1',schdlKbn:'KeyLESSON_SCHDL_SVC',groupSchdlId:'',lessonSchdlId:${JSON.stringify(state.productId)},includeSaleStops:'true',_:String(Date.now())});const text=await (await fetch('/stateful/schdl/client/summary?'+query)).text();
            const data=JSON.parse(text.slice(callback.length+2,-2));await new Promise(r=>setTimeout(r,${state.renderDelayMs ?? 0}));input.style.display='block';const slot=data.dto.plans[0].tmzs[0].slots[0];const list=document.getElementById('slots');list.innerHTML='<li id="'+slot.slotId+'" class="'+(slot.frontOpenFlg?'sale-open':'sale-stop')+'"><a href="#" data-bind="click: $root.onClickSlot.bind($data, $index(), $parent, $parents[1])">slot</a></li>';list.querySelector('a').onclick=(event)=>{event.preventDefault();selected=true;document.getElementById('count').textContent='1/14';};}
          const picker=document.querySelector('.ui-datepicker');let pickerYear=Number(input.value.slice(0,4));let pickerMonth=Number(input.value.slice(5,7))-1;
          function renderPicker(){picker.querySelector('.ui-datepicker-year').textContent=String(pickerYear);picker.querySelector('.ui-datepicker-month').textContent=String(pickerMonth+1)+'月';const days=document.getElementById('picker-days');days.innerHTML='';const count=new Date(Date.UTC(pickerYear,pickerMonth+1,0)).getUTCDate();for(let day=1;day<=count;day++){const td=document.createElement('td');td.dataset.handler='selectDay';td.dataset.year=String(pickerYear);td.dataset.month=String(pickerMonth);const link=document.createElement('a');link.href='#';link.textContent=String(day);link.onclick=(event)=>{event.preventDefault();const date=String(pickerYear)+'-'+String(pickerMonth+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');input.value=date.replaceAll('-','/');picker.hidden=true;load(date.replaceAll('-',''));};td.append(link);days.append(td);}}
          input.onclick=()=>{picker.hidden=false;renderPicker()};for(const direction of ['prev','next'])picker.querySelector('[data-handler="'+direction+'"]').onclick=(event)=>{event.preventDefault();const date=new Date(Date.UTC(pickerYear,pickerMonth+(direction==='next'?1:-1),1));pickerYear=date.getUTCFullYear();pickerMonth=date.getUTCMonth();renderPicker()};
          document.getElementById('complete').onclick=()=>{if(!selected)return;const open=document.querySelector('.js-panel-saleStatus').value==='販売';fetch('/stateful/schdl/client/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({groups:[],slots:[{slotId:${JSON.stringify(state.slotId)},version:1,frontOpenFlg:String(open),bookingAvailableKbn:'KeyUNCONFIRMED',cfmBookingLimMgrKbn:null,cfmCapaCnt:0,lessonSchdlId:${JSON.stringify(state.productId)},lessonSchdlVersion:21}]})});};
          document.getElementById('refresh').onclick=(event)=>{event.preventDefault();load(currentDate)};load(currentDate);
        </script></body></html>`); return;
    }
    if (url.pathname === "/stateful/schdl/client/summary" && request.method === "GET") {
      const compactDate = url.searchParams.get("dspBaseDate") || state.initialDate.replaceAll("-", ""); state.reads.push(Object.fromEntries(url.searchParams));
      const callback = url.searchParams.get("callback"); response.writeHead(200, { "content-type": "application/javascript" });
      response.end(`${callback} (${JSON.stringify(summary(compactDate))});`); return;
    }
    if (url.pathname === "/stateful/schdl/client/complete" && request.method === "POST") {
      const body = await readBody(request); state.requests.push(body); state.writes += 1; state.open = body.slots[0].frontOpenFlg === "true";
      if (state.responseFailure === "drop") { request.socket.destroy(); return; }
      if (state.responseFailure === "500") { response.writeHead(500, { "content-type": "application/json" }); response.end('{"ok":false}'); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return;
    }
    response.writeHead(404); response.end();
  };
  const fixture = await fixtureBase("niho-jalan-", state, handler, "Jalan", "jalan");
  return { ...fixture, makeJob(action, overrides = {}) { return makeJob(state, action, { target: Object.freeze({ site: "Jalan", externalAccountId: state.accountId,
    externalProductId: state.productId, externalOptionId: state.optionId, timeZone: "Asia/Tokyo", adapter: "jalan-browser", adapterVersion: "1", connectionMode: "BROWSER" }), ...overrides }); } };
}
