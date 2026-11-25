import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";

// The booking widget (#638, docs/embed.md) inside another site's frame: the real component on synthetic responses, the
// frame on one origin and the host's page on another. No server, account or live API.
const EXPERIENCE = "https://experience.example.test";
const HOST_SITE = "https://host-site.example.test";
const STRIPE = "https://checkout.stripe.com/c/pay/cs_test_synthetic";
const NAME = "Synthetic Guest";
const EMAIL = "guest@example.test";

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false, envDir: false, logLevel: "error",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      lib: { entry: fileURLToPath(new URL("./fixtures/embed-booking-client.tsx", import.meta.url)), name: "EmbedBookingTest", formats: ["iife"] },
      write: false, minify: false,
    },
  });
  const outputs = Array.isArray(result) ? result : "output" in result ? [result] : [];
  const chunk = outputs.flatMap((output) => output.output).find((output) => output.type === "chunk");
  if (!chunk) throw new Error("Synthetic embed client was not built");
  bundle = chunk.code;
});

const occurrence = (date: string, bookable: boolean, seatsLeft: number) => ({
  offerId: "synthetic-offer", date, bookable, seatsLeft, reason: bookable ? null : "FULL",
  startAt: `${date}T09:00:00Z`, endAt: `${date}T11:00:00Z`, bookingClosesAt: null,
});
/** The second offer's occurrence: noon in Tokyo, the same experience at another time. */
const noonOccurrence = (date: string, bookable: boolean, seatsLeft: number) => ({
  ...occurrence(date, bookable, seatsLeft), offerId: "synthetic-offer-noon", startAt: `${date}T03:00:00Z`, endAt: `${date}T05:00:00Z`,
});

/** The host's page frames the widget and keeps every message it gets from it. */
type WidgetOptions = { layout?: "page" | "embed"; preview?: boolean; refuseWith?: "FULL"; secondOffer?: boolean };

async function openWidget(page: Page, acceptanceMode: "INSTANT" | "APPROVAL", checkoutUrl: string, options: WidgetOptions = {}) {
  const checkouts: unknown[] = [];
  const availabilityReads: string[] = [];
  await page.route(`${HOST_SITE}/`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8">
    <h1>A host's own site</h1><iframe id="widget" src="${EXPERIENCE}/frame" style="width:100%;max-width:520px;height:760px;border:0"></iframe>
    <script>window.received=[];window.addEventListener("message",function(e){if(e.origin==="${EXPERIENCE}")window.received.push(e.data);});</script>` }));
  await page.route(`${EXPERIENCE}/frame`, (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' }));
  await page.route(`${EXPERIENCE}/api/public/experiences/synthetic-dinner/availability**`, (route) => {
    availabilityReads.push(route.request().url());
    // The noon start of 5 Dec is the one a refused checkout just found full: the next read says so.
    const noonTaken = options.refuseWith !== undefined && availabilityReads.length > 1;
    return route.fulfill({ json: {
      occurrences: [occurrence("2026-12-05", true, 6), occurrence("2026-12-12", false, 0), occurrence("2027-01-09", true, 2),
        // An occurrence of an offer the sale terms do not have is never a day of the calendar.
        { ...occurrence("2026-12-19", true, 5), offerId: "offer-not-sold" },
        // With a second offer: a day of its own, a second start on a day the first offer has, and one that is full.
        ...(options.secondOffer ? [noonOccurrence("2026-12-06", true, 3), noonOccurrence("2026-12-05", !noonTaken, noonTaken ? 0 : 4), noonOccurrence("2027-01-09", false, 0)] : [])],
    } });
  });
  await page.route(`${EXPERIENCE}/api/public/experiences/synthetic-dinner/checkout`, async (route) => {
    checkouts.push(route.request().postDataJSON());
    if (options.refuseWith) {
      await route.fulfill({ status: 409, json: { error: { code: options.refuseWith, message: "Not enough seats are left.", retryable: false, field: null, questionId: null, seatsLeft: 0, currentTotalYen: null, occurrenceReason: null } } });
      return;
    }
    await route.fulfill({ status: 201, json: { checkoutUrl } });
  });
  await page.goto(`${HOST_SITE}/`);
  const frame = page.frames().find((candidate) => candidate.url() === `${EXPERIENCE}/frame`);
  if (!frame) throw new Error("The widget's frame did not load");
  await frame.evaluate(() => Object.defineProperty(globalThis, "process", { value: { env: { NODE_ENV: "development" } } }));
  await frame.addScriptTag({ content: bundle });
  await frame.evaluate(([mode, mount]) => window.mountEmbedBooking(mode, mount), [acceptanceMode, { layout: options.layout, preview: options.preview, secondOffer: options.secondOffer }] as const);
  return { widget: page.frameLocator("#widget"), checkouts, availabilityReads };
}

async function fillDetails(page: Page, acceptanceMode: "INSTANT" | "APPROVAL", checkoutUrl: string, options: WidgetOptions = {}) {
  const opened = await openWidget(page, acceptanceMode, checkoutUrl, options);
  const { widget } = opened;
  // Only a bookable day can be pressed.
  await expect(widget.getByRole("button", { name: "Sat 12 Dec, unavailable" })).toBeDisabled();
  await expect(widget.getByRole("button", { name: "Sun 6 Dec, not offered" })).toBeDisabled();
  const continueButton = widget.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeDisabled();
  await widget.getByRole("button", { name: "Sat 5 Dec, 6 places left" }).click();
  await expect(widget.getByRole("button", { name: "Sat 5 Dec, 6 places left" })).toHaveAttribute("aria-pressed", "true");
  await expect(widget.getByText("6:00 PM JST · 6 places left")).toBeVisible();
  await continueButton.click();
  // The step where the traveler agrees shows the conditions the consent refers to.
  await expect(widget.getByText("50% refund when cancelled at least 24 hours before the start")).toBeVisible();
  await widget.getByLabel("Full name").fill(NAME);
  await widget.getByLabel("Email").fill(EMAIL);
  await widget.getByRole("checkbox").check();
  return opened;
}

async function messagesOf(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { received: unknown[] }).received);
}

test("a paid booking holds the seats in the frame and pays on Stripe in the top window", async ({ page }) => {
  const { widget, checkouts } = await fillDetails(page, "INSTANT", STRIPE);
  await widget.getByRole("button", { name: "Continue to secure checkout" }).click();

  const pay = widget.getByRole("link", { name: "Pay securely on Stripe" });
  await expect(pay).toHaveAttribute("href", STRIPE);
  await expect(pay).toHaveAttribute("target", "_top");
  await expect(widget.getByRole("link", { name: "Open payment in a new tab" })).toHaveAttribute("target", "_blank");
  await expect(widget.getByText("Your seats are held for the next 30 minutes.")).toBeVisible();
  // The host's page stays where it was until the traveler presses the button.
  expect(page.url()).toBe(`${HOST_SITE}/`);
  // The provider's mark goes with the request (no utm_* on the frame URL).
  expect(checkouts).toHaveLength(1);
  expect(checkouts[0]).toMatchObject({ guestName: NAME, guestEmail: EMAIL, utmSource: "provider", utmMedium: "embed", occurrenceDate: "2026-12-05" });
  // 販売経路: the widget says it is embedded, with the host page's origin only (no path).
  expect(checkouts[0]).toMatchObject({ salesChannel: "embed", embedOrigin: HOST_SITE });

  const messages = await messagesOf(page);
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    expect(["niho-experience-embed-resize", "niho-experience-embed-top"]).toContain((message as { type?: unknown }).type);
    expect(Object.keys(message as object).every((key) => key === "type" || key === "height")).toBe(true);
  }
  expect(messages.some((message) => (message as { type: string }).type === "niho-experience-embed-top")).toBe(true);
  const sent = JSON.stringify(messages);
  for (const secret of [NAME, EMAIL, "stripe", "cs_test"]) expect(sent).not.toContain(secret);

  await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic Stripe</title>" }));
  await pay.click();
  await page.waitForURL(STRIPE);
});

test("a booking request ends inside the frame without leaving the host's page", async ({ page }) => {
  const { widget } = await fillDetails(page, "APPROVAL", `${EXPERIENCE}/booking/return?type=managed-request`);
  await expect(widget.getByText("3 Done")).toBeVisible();
  await widget.getByRole("button", { name: "Send booking request" }).click();
  await expect(widget.getByRole("heading", { name: "NIHO will review your request" })).toBeVisible();
  expect(page.url()).toBe(`${HOST_SITE}/`);
  expect(page.frames().some((frame) => frame.url() === `${EXPERIENCE}/frame`)).toBe(true);
  const sent = JSON.stringify(await messagesOf(page));
  for (const secret of [NAME, EMAIL, "booking/return"]) expect(sent).not.toContain(secret);
});

test("a date that filled up brings the traveler back to the calendar, with the reason on top", async ({ page }) => {
  const { widget, checkouts } = await fillDetails(page, "INSTANT", STRIPE, { refuseWith: "FULL" });
  await widget.getByRole("button", { name: "Continue to secure checkout" }).click();
  const alert = widget.getByRole("alert");
  await expect(alert).toHaveText("That date is no longer available. Choose another date.");
  await expect(widget.locator('[aria-current="step"]')).toHaveText("1 Date");
  // Above the calendar: the host's page shows the frame from its top after a step changes.
  const [alertBox, calendarBox] = await Promise.all([alert.boundingBox(), widget.getByRole("group", { name: "Date" }).boundingBox()]);
  expect(alertBox!.y).toBeLessThan(calendarBox!.y);
  expect(checkouts).toHaveLength(1);
  expect(page.url()).toBe(`${HOST_SITE}/`);
});

// The host added 開催枠 one at a time: each is its own offer, and all of them are days of the one calendar.
test("every offer's dates are in the one calendar, and the date chooses the offer", async ({ page }) => {
  const { widget, checkouts, availabilityReads } = await openWidget(page, "INSTANT", STRIPE, { secondOffer: true });
  await expect(widget.getByRole("combobox")).toHaveCount(0);
  await expect(widget.getByText("From ¥4,000 per adult")).toBeVisible();
  await expect(widget.getByText("Choose a date", { exact: true })).toBeVisible();
  // One read for every offer, and only the offers on sale are days.
  expect(availabilityReads).toEqual([`${EXPERIENCE}/api/public/experiences/synthetic-dinner/availability`]);
  await expect(widget.getByRole("button", { name: "Sat 19 Dec, not offered" })).toBeDisabled();

  // A day only the second offer has.
  await widget.getByRole("button", { name: "Sun 6 Dec, 3 places left" }).click();
  await expect(widget.getByText("12:00 PM JST · 3 places left")).toBeVisible();
  await expect(widget.getByText("¥4,000 per adult", { exact: true })).toBeVisible();
  await expect(widget.getByRole("radio")).toHaveCount(0);

  // A day both offers have: the earliest start is chosen, and the other can be.
  await widget.getByRole("button", { name: "Sat 5 Dec, 4 places left" }).click();
  const starts = widget.getByRole("radiogroup", { name: "Start time on Sat 5 Dec" });
  await expect(starts.getByRole("radio")).toHaveCount(2);
  await expect(starts.getByRole("radio", { name: "12:00 PM JST · 4 places left · ¥4,000 per adult" })).toBeChecked();
  // The choice is read out from a region that was already there.
  await expect(widget.getByText("Selected: Sat 5 Dec, 12:00 PM JST, 4 places left. 2 start times that day.")).toHaveAttribute("aria-live", "polite");
  await starts.getByRole("radio", { name: "6:00 PM JST · 6 places left · ¥5,000 per adult" }).check();
  await expect(widget.getByText("¥5,000 per adult", { exact: true })).toBeVisible();
  // Pressing the chosen day again keeps the start chosen on it.
  await widget.getByRole("button", { name: "Sat 5 Dec, 4 places left" }).click();
  await expect(starts.getByRole("radio", { name: "6:00 PM JST · 6 places left · ¥5,000 per adult" })).toBeChecked();
  await widget.getByLabel("Adults").fill("2");

  await widget.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(widget.getByText("Sat 5 Dec · 6:00 PM JST")).toBeVisible();
  await widget.getByLabel("Full name").fill(NAME);
  await widget.getByLabel("Email").fill(EMAIL);
  await widget.getByRole("checkbox").check();
  await widget.getByRole("button", { name: "Continue to secure checkout" }).click();
  await expect(widget.getByRole("link", { name: "Pay securely on Stripe" })).toBeVisible();
  expect(checkouts).toHaveLength(1);
  expect(checkouts[0]).toMatchObject({ offerId: "synthetic-offer", occurrenceDate: "2026-12-05", adultCount: 2, expectedTotalYen: 10000 });
});

test("a start that filled up is read again, so its day chooses the start that is left", async ({ page }) => {
  const { widget, checkouts, availabilityReads } = await openWidget(page, "INSTANT", STRIPE, { secondOffer: true, refuseWith: "FULL" });
  await widget.getByRole("button", { name: "Sat 5 Dec, 4 places left" }).click();
  await widget.getByRole("button", { name: "Continue", exact: true }).click();
  await widget.getByLabel("Full name").fill(NAME);
  await widget.getByLabel("Email").fill(EMAIL);
  await widget.getByRole("checkbox").check();
  await widget.getByRole("button", { name: "Continue to secure checkout" }).click();
  await expect(widget.getByRole("alert")).toHaveText("That date is no longer available. Choose another date.");
  await expect(widget.locator('[aria-current="step"]')).toHaveText("1 Date");
  expect(checkouts[0]).toMatchObject({ offerId: "synthetic-offer-noon", occurrenceDate: "2026-12-05", expectedTotalYen: 4000 });
  // Nothing is chosen any more: the price is "From" again and the next step is closed.
  await expect(widget.getByText("From ¥4,000 per adult")).toBeVisible();
  await expect(widget.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  // The second read knows the noon start is full: the day stands for the evening one.
  await expect.poll(() => availabilityReads.length).toBe(2);
  await widget.getByRole("button", { name: "Sat 5 Dec, 6 places left" }).click();
  const starts = widget.getByRole("radiogroup", { name: "Start time on Sat 5 Dec" });
  await expect(starts.getByRole("radio", { name: "12:00 PM JST · Full" })).toBeDisabled();
  await expect(starts.getByRole("radio", { name: "6:00 PM JST · 6 places left · ¥5,000 per adult" })).toBeChecked();
  await expect(widget.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
});

test("a start that is full stays in the list of its day and cannot be chosen", async ({ page }) => {
  const { widget, checkouts } = await openWidget(page, "INSTANT", STRIPE, { secondOffer: true, layout: "page" });
  await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic Stripe</title>" }));
  await widget.getByRole("button", { name: "Next month" }).click();
  await widget.getByRole("button", { name: "Sat 9 Jan, 2 places left" }).click();
  const starts = widget.getByRole("radiogroup", { name: "Start time on Sat 9 Jan" });
  await expect(starts.getByRole("radio", { name: "12:00 PM JST · Full" })).toBeDisabled();
  await expect(starts.getByRole("radio", { name: "6:00 PM JST · 2 places left · ¥5,000 per adult" })).toBeChecked();
  await widget.getByLabel("Full name").fill(NAME);
  await widget.getByLabel("Email").fill(EMAIL);
  await widget.getByRole("checkbox").check();
  await widget.getByRole("button", { name: "Continue to secure checkout" }).click();
  await expect.poll(() => checkouts.length).toBe(1);
  expect(checkouts[0]).toMatchObject({ offerId: "synthetic-offer", occurrenceDate: "2027-01-09", expectedTotalYen: 5000 });
});

test("the preview shows the calendar and takes no booking", async ({ page }) => {
  const { widget, checkouts } = await openWidget(page, "INSTANT", STRIPE, { preview: true });
  await widget.getByRole("button", { name: "Sat 5 Dec, 6 places left" }).click();
  await expect(widget.getByText("6:00 PM JST · 6 places left")).toBeVisible();
  await expect(widget.getByText("Preview. Booking is turned off here.")).toBeVisible();
  await expect(widget.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  expect(checkouts).toHaveLength(0);
});

test("the public booking page keeps one screen: a date from the calendar, then checkout opens by itself", async ({ page }) => {
  const { widget, checkouts } = await openWidget(page, "INSTANT", STRIPE, { layout: "page" });
  await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic Stripe</title>" }));
  const submit = widget.getByRole("button", { name: "Continue to secure checkout" });
  await expect(submit).toBeDisabled();
  await expect(widget.getByText("Powered by NIHO Experience")).toHaveCount(0);
  await widget.getByRole("button", { name: "Sat 5 Dec, 6 places left" }).click();
  await widget.getByLabel("Full name").fill(NAME);
  await widget.getByLabel("Email").fill(EMAIL);
  await widget.getByRole("checkbox").check();
  await submit.click();
  await expect.poll(() => page.frames().some((frame) => frame.url() === STRIPE)).toBe(true);
  expect(checkouts).toHaveLength(1);
  expect(checkouts[0]).toMatchObject({ occurrenceDate: "2026-12-05", adultCount: 1, expectedTotalYen: 5000 });
  expect(checkouts[0]).not.toHaveProperty("utmMedium");
  expect(checkouts[0]).not.toHaveProperty("salesChannel");
  expect(checkouts[0]).not.toHaveProperty("embedOrigin");
});
