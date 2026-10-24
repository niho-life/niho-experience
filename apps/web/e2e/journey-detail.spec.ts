import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Epic #103 (niho-experience#105): participation conditions and "Ask {host} a question" on the detail page. Mock data only.
const indigo = "/experiences/indigo-dyeing-with-an-artisan";
const dinner = "/experiences/home-cooked-dinner-with-locals";
const pottery = "/experiences/evening-pottery-session";
const askButton = (page: Page) => page.getByRole("button", { name: /^Ask .* a question$/ });

async function openAsk(page: Page) {
  await askButton(page).click();
  // The sheet's name follows its heading: "Ask Aiko" while writing, "Question sent" afterwards.
  const dialog = page.getByRole("dialog", { name: /^(Ask |Question sent)/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("Good to know lists each condition with its detail and keeps the host's own notes below", async ({ page }) => {
  await page.goto(indigo);
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Good to know", exact: true }) });
  for (const text of ["Ages 10 and up", "Children must join with an adult", "Standing for a long time", "Working with your hands · about 2 hours, with short breaks", "Hosted in Japanese and basic English", "Vegan option on request", "Not wheelchair accessible", "Steps up to the studio", "Rain or shine"]) {
    await expect(section.getByText(text, { exact: true })).toBeVisible();
  }
  const written = await section.innerText();
  expect(written.indexOf("Ages 10 and up")).toBeLessThan(written.indexOf("Wear clothes that can get stained."));
  expect(written.indexOf("Wear clothes that can get stained.")).toBeLessThan(written.indexOf("Ask "));
});

test("an experience without conditions keeps the host's list, and a closed one has no question button", async ({ page }) => {
  await page.goto(dinner);
  await expect(page.getByText("Please arrive five minutes early.", { exact: true })).toBeVisible();
  await expect(page.getByText("Ages 10 and up", { exact: true })).toHaveCount(0);
  await expect(askButton(page)).toBeVisible();
  // Conditions without a question button: the pottery session takes no bookings, so it takes no questions either.
  await page.goto(pottery);
  await expect(page.getByText("Hosted in Japanese and basic English", { exact: true })).toBeVisible();
  await expect(askButton(page)).toHaveCount(0);
});

test("a question goes from the sheet, the reply is promised by email, and nothing the traveler typed is kept", async ({ page }) => {
  await page.goto(indigo);
  const trigger = askButton(page);
  const dialog = await openAsk(page);
  await expect(dialog.getByRole("textbox", { name: "Your question" })).toBeFocused();
  await expect(dialog.getByText("What is it about?")).toBeVisible();
  await dialog.getByRole("radio", { name: "Children" }).check();
  await dialog.getByRole("textbox", { name: "Your question" }).fill("Can I join with my 9-year-old daughter? She can sit still for about 20 minutes.");
  await dialog.getByRole("textbox", { name: "Your name" }).fill("Emma");
  await dialog.getByRole("textbox", { name: /^Email/ }).fill("emma@example.com");
  await dialog.getByRole("button", { name: "Send question" }).click();

  await expect(dialog.getByRole("heading", { name: "Question sent" })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("The reply will come to emma@example.com.");
  await expect(dialog.getByRole("button", { name: "Done" })).toBeFocused();
  expect(page.url()).not.toContain("emma");
  expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  // The next question starts from a clean form.
  const again = await openAsk(page);
  await expect(again.getByRole("textbox", { name: "Your question" })).toHaveValue("");
  await expect(again.getByRole("textbox", { name: /^Email/ })).toHaveValue("");
});

test("the sheet closes with Escape and the close button, and returns focus to the button", async ({ page }) => {
  await page.goto(indigo);
  const trigger = askButton(page);
  const dialog = await openAsk(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await openAsk(page);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("a question that is too short or has a bad email is fixed in place without losing the rest", async ({ page }) => {
  await page.goto(indigo);
  const dialog = await openAsk(page);
  await dialog.getByRole("textbox", { name: "Your question" }).fill("hi");
  await dialog.getByRole("textbox", { name: "Your name" }).fill("Emma");
  await dialog.getByRole("textbox", { name: /^Email/ }).fill("emma@example.com");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Write your question in at least 5 characters.");
  await expect(dialog.getByRole("textbox", { name: "Your question" })).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "Your question" })).toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("textbox", { name: "Your question" }).fill("Is there a place to leave a stroller?");
  await dialog.getByRole("textbox", { name: /^Email/ }).fill("not-an-email");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Please check your email address.");
  await expect(dialog.getByRole("textbox", { name: /^Email/ })).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "Your name" })).toHaveValue("Emma");
});

test("when sending fails the message stays and can be sent again", async ({ page }) => {
  await page.goto(`${indigo}?mock=ask-send-failed`);
  const dialog = await openAsk(page);
  await dialog.getByRole("textbox", { name: "Your question" }).fill("Is there a place to leave a stroller?");
  await dialog.getByRole("textbox", { name: "Your name" }).fill("Emma");
  await dialog.getByRole("textbox", { name: /^Email/ }).fill("emma@example.com");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByRole("alert")).toContainText("We couldn't send your question");
  await expect(dialog.getByRole("textbox", { name: "Your question" })).toHaveValue("Is there a place to leave a stroller?");
  await expect(dialog.getByRole("button", { name: "Send question" })).toBeEnabled();
  await expect(dialog.getByRole("heading", { name: "Question sent" })).toHaveCount(0);
});

test("a rate limit waits for the seconds NIHO asks for, and a closed question line says so", async ({ page }) => {
  await page.goto(`${indigo}?mock=ask-rate-limited`);
  let dialog = await openAsk(page);
  const fill = async () => {
    await dialog.getByRole("textbox", { name: "Your question" }).fill("Is there a place to leave a stroller?");
    await dialog.getByRole("textbox", { name: "Your name" }).fill("Emma");
    await dialog.getByRole("textbox", { name: /^Email/ }).fill("emma@example.com");
    await dialog.getByRole("button", { name: "Send question" }).click();
  };
  await fill();
  await expect(dialog.getByRole("alert")).toContainText("You've sent a few questions already");
  await expect(dialog.getByRole("alert")).toContainText("Please wait 90 seconds");
  await expect(dialog.getByRole("button", { name: /^Please wait \d+s$/ })).toBeDisabled();

  await page.goto(`${indigo}?mock=ask-unavailable`);
  dialog = await openAsk(page);
  await fill();
  await expect(dialog.getByRole("alert")).toContainText("isn't taking questions about this experience right now");
});

test("the sheet has no serious accessibility violations and fits the viewport", async ({ page }) => {
  await page.goto(indigo);
  const dialog = await openAsk(page);
  const results = await new AxeBuilder({ page }).include("dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box && box.x >= 0 && box.x + box.width <= viewport.width).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
