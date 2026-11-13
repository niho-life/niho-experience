import { expect, test, type Page } from "@playwright/test";

/*
 * 団体・個別の相談 (#532): the form at phone width, with the POST stubbed (the mock server stores nothing). The page is
 * on only for this server's preview flag; the real route is covered by its own unit tests.
 */
const ENDPOINT = "**/api/public/group-inquiries";
const ACCEPTED = { accepted: true, inquiryRef: "IQ-7K3M9Q2X", replyByDate: "2026-11-17" };

type Sent = { clientRequestKey: string; [field: string]: unknown };

async function stub(page: Page, answer: (sent: Sent, index: number) => { status: number; body?: unknown; delayMs?: number; headers?: Record<string, string> }) {
  const requests: Sent[] = [];
  await page.route(ENDPOINT, async (route) => {
    const sent = route.request().postDataJSON() as Sent;
    requests.push(sent);
    const reply = answer(sent, requests.length - 1);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    await route.fulfill({ status: reply.status, contentType: "application/json", headers: reply.headers, body: JSON.stringify(reply.body ?? null) });
  });
  return requests;
}

async function fillRequired(page: Page) {
  await page.getByLabel(/Your name/).fill("Sample Teacher");
  await page.getByLabel(/^Email/).fill("teacher@example.com");
  await page.getByLabel(/What would you like to ask/).fill("We would like to plan a half-day program for 30 students.");
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("sends with only the three required answers, the rest left undecided, and shows what was received", async ({ page }) => {
  const requests = await stub(page, () => ({ status: 201, body: ACCEPTED }));
  await page.goto("/inquiry?type=school");
  await expect(page.getByRole("heading", { name: "Talk to us", level: 1 })).toBeVisible();
  // The free first conversation is said under the form before anything is sent.
  await expect(page.getByText("The first conversation is free, about 20 minutes.").first()).toBeVisible();
  // A school's own optional questions are offered, with a per-person / whole-group budget choice.
  await expect(page.getByLabel(/Name of the company, organization or school/)).toBeVisible();
  await expect(page.getByLabel(/Grade/)).toBeVisible();
  await expect(page.getByText("per person")).toBeVisible();
  await expect(page.getByText("for the whole group")).toBeVisible();
  await fillRequired(page);
  await page.getByRole("button", { name: "Send inquiry" }).click();
  const status = page.getByRole("status");
  await expect(status).toContainText("We received your inquiry");
  await expect(status).toContainText("IQ-7K3M9Q2X");
  await expect(status).toContainText("by 17 Nov");
  await expect(status).toContainText("Nothing is booked yet.");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ kind: "SCHOOL", locale: "en", name: "Sample Teacher", email: "teacher@example.com", entry: "DIRECT" });
  // Nothing optional was filled in: no answer is sent as a value.
  expect(Object.values(requests[0]!.details as Record<string, string>).filter((value) => value !== "")).toEqual([]);
  expect(await noHorizontalScroll(page)).toBe(true);
  // What was typed is gone from the page once it was accepted.
  await page.getByRole("button", { name: "Send another inquiry" }).click();
  await expect(page.getByLabel(/Your name/)).toHaveValue("");
});

test("has no horizontal scroll at 320px, with a long kind picked", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/inquiry?type=corporate");
  await expect(page.getByLabel(/Venue|Purpose/).first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByRole("radio", { name: /Individual or group/ }).check();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("keeps where the person came from on screen until the inquiry is accepted, through a failed send", async ({ page }) => {
  const requests = await stub(page, (_sent, index) => (index === 0 ? { status: 503, body: { error: { code: "SEND_FAILED", retryable: true, field: null } } } : { status: 201, body: ACCEPTED }));
  await page.goto("/inquiry?from=experience&experience=sample-tea&title=Tea%20at%20a%20temple&host=Sato");
  await expect(page.getByText("An inquiry for Sato")).toBeVisible();
  await expect(page.getByText("Tea at a temple", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel(/Experience or host you are interested in/)).toHaveValue("Tea at a temple");
  await fillRequired(page);
  await page.getByRole("button", { name: "Send inquiry" }).click();
  // Not accepted: no "received", the context and every typed word stay, and the way to try again is the same button.
  await expect(page.getByRole("main").getByRole("alert")).toContainText("We couldn't send your inquiry");
  await expect(page.getByText("We received your inquiry")).toHaveCount(0);
  await expect(page.getByText("An inquiry for Sato")).toBeVisible();
  await expect(page.getByLabel(/Your name/)).toHaveValue("Sample Teacher");
  await expect(page.getByLabel(/What would you like to ask/)).toHaveValue(/half-day program/);
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.getByRole("status")).toContainText("We received your inquiry");
  // The retry of the same content is the same submission on the server.
  expect(requests).toHaveLength(2);
  expect(requests[1]!.clientRequestKey).toBe(requests[0]!.clientRequestKey);
  expect(requests[1]).toMatchObject({ entry: "EXPERIENCE", experienceSlug: "sample-tea", experienceTitle: "Tea at a temple", hostName: "Sato" });
});

test("a double tap sends once, and the experience can be left out", async ({ page }) => {
  const requests = await stub(page, () => ({ status: 201, body: ACCEPTED, delayMs: 400 }));
  await page.goto("/inquiry?from=experience&experience=sample-tea&title=Tea%20at%20a%20temple");
  await fillRequired(page);
  await page.getByLabel(/Experience or host you are interested in/).fill("");
  const send = page.getByRole("button", { name: "Send inquiry" });
  await send.dblclick();
  await expect(page.getByRole("status")).toContainText("We received your inquiry");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.experienceSlug).toBeNull();
  expect(requests[0]!.experienceTitle).toBeNull();
});

test("points at a missing required answer without sending, and keeps the rest", async ({ page }) => {
  const requests = await stub(page, () => ({ status: 201, body: ACCEPTED }));
  await page.goto("/inquiry");
  await page.getByLabel(/Your name/).fill("Sample Teacher");
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Please check your email address.");
  await expect(page.getByLabel(/^Email/)).toBeFocused();
  await expect(page.getByLabel(/Your name/)).toHaveValue("Sample Teacher");
  expect(requests).toHaveLength(0);
});

test("a rate limit says how long to wait and keeps what was typed", async ({ page }) => {
  await stub(page, () => ({ status: 429, headers: { "retry-after": "90" }, body: { error: { code: "RATE_LIMITED", retryable: true, field: null } } }));
  await page.goto("/inquiry");
  await fillRequired(page);
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Please wait about 90 seconds");
  await expect(page.getByLabel(/Your name/)).toHaveValue("Sample Teacher");
  await expect(page.getByRole("button", { name: /Please wait/ })).toBeDisabled();
});
