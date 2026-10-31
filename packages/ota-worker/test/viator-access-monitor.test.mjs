import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { createViatorAccessMonitor } from "../src/viator-access-monitor.mjs";

class FakePage extends EventEmitter {
  frames() { return []; }
}

const request = (url, type = "document") => ({ url: () => url, resourceType: () => type });
const response = (url, status, type = "document") => ({ url: () => url, status: () => status, request: () => request(url, type) });

function setup() {
  const page = new FakePage();
  const persisted = [];
  let freezes = 0;
  const monitor = createViatorAccessMonitor({
    page,
    guard: { freeze() { freezes += 1; } },
    profile: "/synthetic/private/profile",
    supplierOrigin: "https://supplier.viator.com",
    async persistHold(profile, reason) { persisted.push([profile, reason]); },
  });
  return { page, monitor, persisted, freezes: () => freezes };
}

test("captcha-delivery document freezes once but ordinary script and image do not", async () => {
  const fixture = setup();
  fixture.page.emit("request", request("https://geo.captcha-delivery.com/challenge.js", "script"));
  fixture.page.emit("request", request("https://geo.captcha-delivery.com/pixel.png", "image"));
  assert.equal(await fixture.monitor.assertAvailable(), true);
  assert.equal(fixture.freezes(), 0);
  fixture.page.emit("request", request("https://geo.captcha-delivery.com/captcha/synthetic", "document"));
  fixture.page.emit("request", request("https://geo.captcha-delivery.com/captcha/duplicate", "document"));
  await assert.rejects(fixture.monitor.assertAvailable(), (error) => error.code === "SITE_ACCESS_RESTRICTED" && error.reasonCode === "BOT_CHALLENGE");
  assert.equal(fixture.freezes(), 1);
  assert.deepEqual(fixture.persisted, [["/synthetic/private/profile", "BOT_CHALLENGE"]]);
  await fixture.monitor.stop();
});

test("supplier document and bounded availability endpoints treat 403/429 as access holds", async () => {
  for (const [url, status, expected] of [
    ["https://supplier.viator.com/availability/", 403, "ACCESS_RESTRICTED"],
    ["https://supplier.viator.com/availability/api", 429, "RATE_LIMITED"],
    ["https://supplier.viator.com/availability/update", 403, "ACCESS_RESTRICTED"],
  ]) {
    const fixture = setup();
    fixture.page.emit("response", response(url, status, url.endsWith("/") ? "document" : "xhr"));
    await assert.rejects(fixture.monitor.assertAvailable(), (error) => error.code === "SITE_ACCESS_RESTRICTED" && error.reasonCode === expected);
    assert.equal(fixture.freezes(), 1);
    assert.deepEqual(fixture.persisted, [["/synthetic/private/profile", expected]]);
    await fixture.monitor.stop();
  }
});

test("explicit restriction, JavaScript blocker and robot text are detected without retaining body text", async () => {
  for (const [text, expected] of [
    ["Access temporarily restricted", "ACCESS_RESTRICTED"],
    ["アクセスは一時的に制限されています", "ACCESS_RESTRICTED"],
    ["Please enable JS and disable any ad blocker", "ACCESS_RESTRICTED"],
    ["Please verify you are not a robot", "BOT_CHALLENGE"],
    ["ロボットによるアクセスでないことを確認いたします。", "BOT_CHALLENGE"],
    ["Too many requests. Try again later.", "RATE_LIMITED"],
  ]) {
    const fixture = setup();
    fixture.page.emit("framenavigated", {
      url: () => "https://supplier.viator.com/login",
      locator: () => ({ async innerText() { return text; } }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(fixture.monitor.assertAvailable(), (error) => error.code === "SITE_ACCESS_RESTRICTED" && error.reasonCode === expected);
    assert.deepEqual(fixture.persisted, [["/synthetic/private/profile", expected]]);
    assert.equal(JSON.stringify(fixture.persisted).includes(text), false);
    await fixture.monitor.stop();
  }
});

test("ordinary captcha prose is not treated as a challenge", async () => {
  const fixture = setup();
  fixture.page.frames = () => [{
    url: () => "https://supplier.viator.com/availability/",
    locator: () => ({ async innerText() { return "Our captcha workshop is available"; } }),
  }];
  assert.equal(await fixture.monitor.assertAvailable(), true);
  assert.equal(fixture.freezes(), 0);
  assert.deepEqual(fixture.persisted, []);
  await fixture.monitor.stop();
});

test("assertAvailable rechecks SPA-rendered restriction text without navigation or polling", async () => {
  const fixture = setup();
  let text = "Availability calendar";
  fixture.page.frames = () => [{
    url: () => "https://supplier.viator.com/availability/",
    locator: () => ({ async innerText() { return text; } }),
  }];
  assert.equal(await fixture.monitor.assertAvailable(), true);
  text = "アクセスは一時的に制限されています";
  await assert.rejects(fixture.monitor.assertAvailable(), (error) => error.code === "SITE_ACCESS_RESTRICTED"
    && error.reasonCode === "ACCESS_RESTRICTED");
  assert.equal(fixture.freezes(), 1);
  assert.deepEqual(fixture.persisted, [["/synthetic/private/profile", "ACCESS_RESTRICTED"]]);
  await fixture.monitor.stop();
});

test("a separate Node process may delay assertAvailable without unhandled rejection", async () => {
  const moduleUrl = new URL("../src/viator-access-monitor.mjs", import.meta.url).href;
  const script = `
    import { EventEmitter } from "node:events";
    import { createViatorAccessMonitor } from ${JSON.stringify(moduleUrl)};
    class Page extends EventEmitter { frames() { return []; } }
    const page = new Page();
    const monitor = createViatorAccessMonitor({ page, guard: { freeze() {} }, profile: "/synthetic/profile",
      supplierOrigin: "https://supplier.viator.com", async persistHold() { throw new Error("persist failed"); } });
    page.emit("response", { status: () => 429, url: () => "https://supplier.viator.com/availability/api",
      request: () => ({ resourceType: () => "xhr" }) });
    await new Promise((resolve) => setImmediate(resolve));
    try { await monitor.assertAvailable(); process.exitCode = 2; }
    catch (error) { process.exitCode = error.code === "SITE_ACCESS_RESTRICTED" && error.cause?.message === "persist failed" ? 0 : 3; }
  `;
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "--eval", script], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});

test("hold persistence failure still freezes and halts", async () => {
  const page = new FakePage();
  let freezes = 0;
  const monitor = createViatorAccessMonitor({ page, guard: { freeze() { freezes += 1; } }, profile: "/synthetic/private/profile",
    supplierOrigin: "https://supplier.viator.com", async persistHold() { throw new Error("synthetic write failure"); } });
  page.emit("response", response("https://supplier.viator.com/availability/api", 429, "xhr"));
  await assert.rejects(monitor.assertAvailable(), (error) => error.code === "SITE_ACCESS_RESTRICTED" && error.cause?.message === "synthetic write failure");
  assert.equal(freezes, 1);
  await monitor.stop();
});

test("stop detaches all event handlers", async () => {
  const fixture = setup();
  await fixture.monitor.stop();
  fixture.page.emit("request", request("https://geo.captcha-delivery.com/captcha/after-stop", "document"));
  assert.equal(fixture.freezes(), 0);
  assert.deepEqual(fixture.persisted, []);
});


test("a stalled hold write bounds both the operation and monitor shutdown", { timeout: 2_000 }, async () => {
  const page = new FakePage();
  let release;
  let freezes = 0;
  const persistence = new Promise((resolve) => { release = resolve; });
  const monitor = createViatorAccessMonitor({ page, guard: { freeze() { freezes += 1; } }, profile: "/synthetic/profile",
    supplierOrigin: "https://supplier.viator.com", persistHoldTimeoutMs: 20, persistHold: () => persistence });
  page.emit("response", response("https://supplier.viator.com/availability/api", 429, "xhr"));
  let guardTimer;
  try {
    const result = await Promise.race([
      Promise.allSettled([monitor.assertAvailable(), monitor.stop()]),
      new Promise((resolve) => { guardTimer = setTimeout(() => resolve("STALLED"), 300); }),
    ]);
    assert.notEqual(result, "STALLED", "a disk stall must not stall the stopped result");
    assert.equal(result[0].status, "rejected");
    assert.equal(result[0].reason.code, "SITE_ACCESS_RESTRICTED");
    assert.equal(result[0].reason.cause.code, "PROFILE_ACCESS_HOLD_TIMEOUT");
    assert.equal(result[1].status, "fulfilled");
    assert.equal(freezes, 1);
  } finally { clearTimeout(guardTimer); release(); await monitor.stop(); }
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(monitor.assertAvailable(), (error) => error.code === "SITE_ACCESS_RESTRICTED"
    && error.cause.code === "PROFILE_ACCESS_HOLD_TIMEOUT", "a late successful write cannot lift the restriction");
});
