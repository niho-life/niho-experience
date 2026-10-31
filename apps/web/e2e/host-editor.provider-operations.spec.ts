import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

/*
 * 体験の編集 (#89), NIHO 接続版: the mock editor's body fields (見どころ … 注意事項, 当日の流れ, 外観写真) and 日本語 / 英語（自動訳）
 * against a synthetic NIHO (page.route). Runs with the provider-operations config (320 / 360 / 1280px).
 */

const PROVIDER = "sample-provider-kitchen";
const PAGE = "synthetic-page-1";
const now = "2026-10-27T01:00:00.000Z";
const later = "2026-10-27T02:00:00.000Z";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const EDITOR = `/host/experiences/${PAGE}?providerId=${PROVIDER}`;

const svgImage = (label: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#e8dcc8"/><text x="24" y="160" font-size="28">${label}</text></svg>`)}`;
const consent = { version: "synthetic-listing-consent-2", text: "（合成）体験サイトへの掲載と、NIHO の確認に同意します。" };
const inheritedMeeting = { mode: "INHERIT", meetingPoint: { overview: "（合成）駅から歩いて 10 分", address: "（合成）サンプル町 1 丁目", accessNote: "（合成）東口から歩きます。", mapUrl: "", entranceNote: "（合成）木の門の呼び鈴" } };

const offer = {
  id: "offer-1", name: "午前の合成商品", shortDescription: null, sortOrder: 0, isActive: true, priceYen: 5000, childPriceYen: null, childMinAge: null, childMaxAge: null,
  adultRequiredForChild: false, capacity: 6, maxPartySize: 4, minimumParticipants: 1, weekdays: [2, 6], startTime: "10:00", durationMinutes: 90, cutoffDays: 2,
  closedDates: [], cancellationPolicy: "FREE_UNTIL_24H", acceptanceMode: "APPROVAL", spaceScope: "ENTIRE_FACILITY", useZone: [], bookingQuestions: [],
};
type Step = { time: string; title: string; text: string; photoObjectKey: string | null };
const baseContent = {
  lead: "朝市で野菜を選びます", facts: { language: "日本語" }, highlights: ["旬の野菜", "一品を仕上げる"],
  timeline: [{ time: "10:00", title: "集合", text: "合成の案内", photoObjectKey: null }] as Step[],
  description: "実データではない合成の体験です。", included: ["食材"], notIncluded: [], notSuitableFor: ["生ものが苦手な方"],
  meetingPoint: { entranceNote: "合成の入口", exteriorPhotoObjectKey: null as string | null }, knowBeforeYouGo: ["歩きやすい服装"], hostUserIds: [],
};
const pageDetail = (patch: Record<string, unknown> = {}) => ({
  id: PAGE, kind: "EXPERIENCE", slug: "synthetic-workshop", language: "JA", title: "合成の手仕事体験", status: "DRAFT", listOnEntrance: false, publishedAt: null, unpublishedAt: null,
  content: structuredClone(baseContent), photos: [{ objectKey: "photo-a", url: svgImage("A") }, { objectKey: "photo-b", url: svgImage("B") }], coverObjectKey: "photo-a",
  offer, offers: [offer], publishBlockers: [], publicPath: "/living/synthetic/pages/synthetic-workshop", createdAt: now, updatedAt: now, photoAlts: ["表紙", "二枚目"], ...patch,
});
type Detail = ReturnType<typeof pageDetail>;

/** The preview NIHO answers for a Japanese page: `en` holds the English NIHO made, null where it has not. */
function japanesePreview(detail: Detail, en: { lead?: string | null; highlights?: (string | null)[]; title?: string | null } = {}) {
  const { content } = detail;
  const none = (items: string[]) => items.map(() => null);
  return { page: { slug: detail.slug, kind: "EXPERIENCE", language: detail.language, title: detail.title, titleEn: en.title ?? null, content: {
    lead: content.lead, leadEn: en.lead ?? null, facts: { language: content.facts.language, languageEn: "Japanese" },
    highlights: content.highlights, highlightsEn: en.highlights ?? none(content.highlights), description: content.description, descriptionEn: null,
    included: content.included, includedEn: none(content.included), notIncluded: content.notIncluded, notIncludedEn: none(content.notIncluded),
    notSuitableFor: content.notSuitableFor, notSuitableForEn: none(content.notSuitableFor), knowBeforeYouGo: content.knowBeforeYouGo, knowBeforeYouGoEn: none(content.knowBeforeYouGo),
    timeline: content.timeline.map((step) => ({ time: step.time, title: step.title, titleEn: null, text: step.text, textEn: null, photoIndex: null })),
  }, photos: [], coverUrl: null } };
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
const axeSerious = async (page: Page) => expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);

type Patch = { content?: Partial<typeof baseContent>; photoObjectKeys?: string[]; photoAlts?: string[]; language?: string };
/** What NIHO answers after it saves `patch`: the page with the content changes laid over, and a newer version. */
const applied = (detail: Detail, patch: Patch): Detail => ({ ...detail, content: { ...detail.content, ...patch.content } as Detail["content"], updatedAt: later });
type Server = { page: Detail; preview: unknown; patches: Array<{ expectedUpdatedAt: string; patch: Patch }>; previewCalls: number; readStatus: number; patchStatus: number };
/** A synthetic NIHO for one page: GET / PATCH of the page, its preview, the meeting point and the listing. */
async function serve(page: Page, server: Server, onPatch?: (body: Server["patches"][number]) => Response | void) {
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith("/preview")) { server.previewCalls += 1; return json(route, server.preview); }
    if (path.endsWith("/meeting-point")) return json(route, inheritedMeeting);
    if (path.endsWith("/listing")) return json(route, { listing: null, consent });
    if (path.endsWith(`/${PAGE}`) && request.method() === "GET") return server.readStatus === 200 ? json(route, server.page) : json(route, { error: "failed" }, server.readStatus);
    if (path.endsWith(`/${PAGE}`) && request.method() === "PATCH") {
      const body = request.postDataJSON(); server.patches.push(body);
      if (server.patchStatus !== 200) return json(route, { error: "invalid" }, server.patchStatus);
      onPatch?.(body);
      return json(route, server.page);
    }
    return json(route, { error: "not_found" }, 404);
  });
}
const newServer = (detail = pageDetail(), preview: unknown = japanesePreview(detail)): Server => ({ page: detail, preview, patches: [], previewCalls: 0, readStatus: 200, patchStatus: 200 });
const open = async (page: Page) => { await page.goto("/host/auth/mock-login"); await page.goto(EDITOR); await expect(page.getByLabel("題名", { exact: true })).toBeVisible(); };

test("the body fields come in the mock editor's order, and one 保存 sends only what changed with blank rows left out", async ({ page }) => {
  const server = newServer();
  await serve(page, server, ({ patch }) => { server.page = applied(server.page, patch); });
  await open(page);

  // 写真 → ひとこと紹介 → 当日の言語 → 見どころ → 詳しい説明 → 含まれるもの・含まれないもの → 向かない人 → 当日の流れ → 集合場所 → 注意事項.
  const titles = await page.locator("#editor-tab-panel section[aria-labelledby] > div > h2, #editor-tab-panel section[aria-labelledby] > div > div > h2").allTextContents();
  const order = ["写真", "ひとこと紹介", "当日の言語", "見どころ", "詳しい説明", "含まれるもの・含まれないもの", "向かない人", "当日の流れ", "集合場所", "注意事項"];
  expect(titles.filter((title) => order.includes(title))).toEqual(order);
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);

  await page.getByRole("textbox", { name: "ひとこと紹介" }).fill("新しいひとこと");
  await page.getByRole("textbox", { name: "当日の言語" }).fill(" 英語と日本語 ");
  await page.getByRole("button", { name: "見どころに行を足す" }).click();
  await page.getByLabel("見どころ 3", { exact: true }).fill("三つ目の見どころ");
  await page.getByRole("button", { name: "含まれるものに行を足す" }).click();
  await page.getByLabel("含まれるもの 2", { exact: true }).fill("お茶");
  await page.getByRole("button", { name: "含まれないものに行を足す" }).click();
  await page.getByLabel("含まれないもの 1", { exact: true }).fill("別売りの飲み物");
  await page.getByRole("button", { name: "向かない人に行を足す" }).click(); // left blank: dropped, no change on its own
  await page.getByRole("button", { name: "注意事項に行を足す" }).click();
  await page.getByLabel("注意事項 2", { exact: true }).fill("雨具");
  await page.getByRole("button", { name: "段を足す" }).click();
  await page.getByLabel("当日の流れ 2 の時刻").fill("9:30");
  await page.getByLabel("当日の流れ 2 の題").fill("出迎え");
  await page.getByLabel("当日の流れ 2 の一言").fill("お茶を出します");
  await page.getByLabel("当日の流れ 2 の写真").selectOption({ label: "写真 2" });
  await page.getByLabel("外観写真", { exact: true }).selectOption({ label: "写真 1（表紙）" });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();

  expect(server.patches).toHaveLength(1);
  expect(server.patches[0]!.expectedUpdatedAt).toBe(now);
  expect(Object.keys(server.patches[0]!.patch)).toEqual(["content"]);
  expect(server.patches[0]!.patch.content).toEqual({
    lead: "新しいひとこと", facts: { language: "英語と日本語" }, highlights: ["旬の野菜", "一品を仕上げる", "三つ目の見どころ"], included: ["食材", "お茶"], notIncluded: ["別売りの飲み物"],
    knowBeforeYouGo: ["歩きやすい服装", "雨具"],
    timeline: [{ time: "10:00", title: "集合", text: "合成の案内", photoObjectKey: null }, { time: "09:30", title: "出迎え", text: "お茶を出します", photoObjectKey: "photo-b" }],
    meetingPoint: { entranceNote: "合成の入口", exteriorPhotoObjectKey: "photo-a" },
  });
  // 保存 goes away with the change, and nothing of 迎える人 or 参加の条件 is on the page.
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "迎える人" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "参加の条件" })).toHaveCount(0);
  await noOverflow(page); await axeSerious(page);
});

test("a time that is not 24-hour HH:mm stops the save before anything is sent, and a failed save keeps every input", async ({ page }) => {
  const server = newServer();
  await serve(page, server);
  await open(page);
  await page.getByRole("textbox", { name: "ひとこと紹介" }).fill("保存前のひとこと");
  await page.getByLabel("当日の流れ 1 の時刻").fill("25:00");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "当日の流れ 1 の時刻は、18:00 のように 24 時間で入力してください。" })).toBeVisible();
  expect(server.patches).toHaveLength(0);

  // A blank step is no step: fixing the time sends the save, which NIHO refuses (400): nothing typed is lost.
  await page.getByLabel("当日の流れ 1 の時刻").fill("10:30");
  server.patchStatus = 400;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "保存できませんでした。入力は保持しています。" })).toBeVisible();
  expect(server.patches).toHaveLength(1);
  await expect(page.getByRole("textbox", { name: "ひとこと紹介" })).toHaveValue("保存前のひとこと");
  await expect(page.getByLabel("当日の流れ 1 の時刻")).toHaveValue("10:30");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
});

test("a page that cannot be read says so and reads again on 読み込み直す, without saying a save failed", async ({ page }) => {
  const server = newServer(); server.readStatus = 500;
  await serve(page, server);
  await page.goto("/host/auth/mock-login"); await page.goto(EDITOR);
  const alert = page.getByRole("alert").filter({ hasText: "体験を読み込めませんでした。" });
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText("保存");
  server.readStatus = 200;
  await alert.getByRole("button", { name: "読み込み直す" }).click();
  await expect(page.getByLabel("題名", { exact: true })).toHaveValue("合成の手仕事体験");
  await expect(page.getByRole("alert").filter({ hasText: "読み込めませんでした" })).toHaveCount(0);
});

test("a Japanese page's English tab reads NIHO's English, says what NIHO has not made, and follows the saved Japanese", async ({ page }) => {
  const detail = pageDetail();
  const server = newServer(detail, japanesePreview(detail, { title: "A hands-on workshop", lead: "Pick vegetables at the market", highlights: ["Seasonal vegetables", null] }));
  await serve(page, server, ({ patch }) => {
    server.page = applied(server.page, patch);
    // NIHO's English follows the Japanese it was made from: a changed lead has none until NIHO makes it again.
    server.preview = japanesePreview(server.page, { title: "A hands-on workshop", highlights: ["Seasonal vegetables", null] });
  });
  await open(page);

  const tabs = page.getByRole("tablist", { name: "原稿の言語" });
  const english = tabs.getByRole("tab", { name: /英語（自動訳）/ });
  await expect(english).toContainText("一部のみ");
  await english.click();
  const state = page.getByRole("region", { name: "英語の状態" });
  await expect(state).toContainText("英語がまだない項目があります。");
  await expect(state).toContainText("この画面では直せません。");
  await expect(page.getByRole("region", { name: "英語の題名" })).toContainText("A hands-on workshop");
  await expect(page.getByRole("region", { name: "ひとこと紹介" })).toContainText("Pick vegetables at the market");
  const highlights = page.getByRole("region", { name: "見どころ", exact: true });
  await expect(highlights).toContainText("Seasonal vegetables");
  await expect(highlights).toContainText("英語はまだありません");
  await expect(highlights).toContainText("日本語: 一品を仕上げる");
  // Read only: the tab has no field to type in, and no way to make, correct or confirm English.
  await expect(page.locator("#editor-tab-panel").getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /英語を確定|英語の下書き|英語を作り直す/ })).toHaveCount(0);
  await noOverflow(page); await axeSerious(page);

  // Unsaved Japanese is not in the English yet; saving it reads the English again.
  await tabs.getByRole("tab", { name: "日本語で書く" }).click();
  await page.getByRole("textbox", { name: "ひとこと紹介" }).fill("新しいひとこと");
  await english.click();
  await expect(state).toContainText("未保存の変更があります。");
  const callsBefore = server.previewCalls;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  await expect.poll(() => server.previewCalls).toBeGreaterThan(callsBefore);
  await expect(page.getByRole("region", { name: "ひとこと紹介" })).toContainText("英語はまだありません");
  await expect(page.getByRole("region", { name: "ひとこと紹介" })).toContainText("日本語: 新しいひとこと");
  await expect(state).not.toContainText("未保存の変更があります。");
  // 英語を読み直す reads it once more.
  const before = server.previewCalls;
  await state.getByRole("button", { name: "英語を読み直す" }).click();
  await expect.poll(() => server.previewCalls).toBeGreaterThan(before);
});

test("the English tab says when NIHO's English cannot be read, and a page saved in English has no tab", async ({ page }) => {
  const server = newServer();
  await serve(page, server);
  await open(page);
  // The preview is a 404 (no active offer): said in words, with a way to try again.
  await page.unroute(`**/host/api/provider-pages/${PROVIDER}**`);
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview")) return json(route, { error: "not_found" }, 404);
    if (path.endsWith("/meeting-point")) return json(route, inheritedMeeting);
    if (path.endsWith("/listing")) return json(route, { listing: null, consent });
    return json(route, server.page);
  });
  await page.getByRole("tab", { name: /英語（自動訳）/ }).click();
  await page.getByRole("button", { name: "英語を読み直す" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "英語を読めませんでした。有効な商品を 1 つ以上保存すると、保存した内容から読めます。" })).toBeVisible();

  // An English page has English as its words and no tab.
  const english = newServer(pageDetail({ language: "EN" }));
  await page.unroute(`**/host/api/provider-pages/${PROVIDER}**`);
  await serve(page, english);
  await page.goto(EDITOR);
  await expect(page.getByLabel("題名", { exact: true })).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "ひとこと紹介" })).toHaveAttribute("lang", "en");
  expect(english.previewCalls).toBe(0);
});

test("switching the writing language asks first, keeps the words, and is one change in the next save", async ({ page }) => {
  const server = newServer();
  await serve(page, server, ({ patch }) => { server.page = { ...applied(server.page, patch), language: patch.language ?? server.page.language }; });
  await open(page);
  const pagePanel = page.getByRole("region", { name: "ページ", exact: true });
  await pagePanel.getByRole("radio", { name: "English" }).click({ force: true });
  const dialog = page.getByRole("dialog", { name: "英語で書く形に切り替えますか？" });
  await expect(dialog).toContainText("本文は今のまま残ります。");
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(pagePanel.getByRole("radio", { name: "日本語" })).toBeChecked();
  await expect(page.getByRole("tablist")).toBeVisible();

  await pagePanel.getByRole("radio", { name: "English" }).click({ force: true });
  await dialog.getByRole("button", { name: "英語で書く" }).click();
  await expect(pagePanel.getByRole("radio", { name: "English" })).toBeChecked();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "ひとこと紹介" })).toHaveValue("朝市で野菜を選びます");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  expect(server.patches.map((item) => item.patch)).toEqual([{ language: "EN" }]);
});

test("another editor's change to 当日の流れ is listed as one conflict and never overwritten", async ({ page }) => {
  const server = newServer(); let patches = 0;
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith("/preview")) return json(route, server.preview);
    if (path.endsWith("/meeting-point")) return json(route, inheritedMeeting);
    if (path.endsWith("/listing")) return json(route, { listing: null, consent });
    if (path.endsWith(`/${PAGE}`) && request.method() === "GET") return json(route, server.page);
    if (path.endsWith(`/${PAGE}`) && request.method() === "PATCH") {
      patches += 1; const body = request.postDataJSON(); server.patches.push(body);
      if (patches === 1) { server.page = pageDetail({ updatedAt: later, content: { ...baseContent, timeline: [{ time: "10:00", title: "別の人の集合", text: "", photoObjectKey: null }] } }); return json(route, { error: "conflict" }, 409); }
      server.page = pageDetail({ updatedAt: "2026-10-27T03:00:00.000Z", content: { ...baseContent, ...body.patch.content } });
      return json(route, server.page);
    }
    return json(route, { error: "not_found" }, 404);
  });
  await open(page);
  await page.getByLabel("当日の流れ 1 の題").fill("自分の集合");
  await page.getByRole("textbox", { name: "ひとこと紹介" }).fill("自分のひとこと");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "ほかの人が先に保存しました" })).toBeVisible();
  await page.getByRole("button", { name: "最新の保存内容を読む" }).click();
  const merge = page.locator("section").filter({ has: page.getByRole("heading", { name: "最新の保存内容と照合" }) });
  await expect(merge).toContainText("同じ項目が変更されています");
  await expect(merge.getByRole("listitem")).toHaveCount(1);
  await expect(merge.getByRole("listitem")).toContainText("当日の流れ");
  await expect(merge.getByRole("listitem")).toContainText("10:00 自分の集合");
  await expect(merge.getByRole("listitem")).toContainText("10:00 別の人の集合");
  await page.getByRole("button", { name: "競合項目は自分の入力を残す" }).click();
  await expect(page.getByLabel("当日の流れ 1 の題")).toHaveValue("自分の集合");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  expect(server.patches[1]!.expectedUpdatedAt).toBe(later);
  expect(server.patches[1]!.patch.content!.timeline).toEqual([{ time: "10:00", title: "自分の集合", text: "合成の案内", photoObjectKey: null }]);
});

test("removing the photo a step and the exterior photo use leaves them without one, as NIHO does on save", async ({ page }) => {
  const detail = pageDetail({ content: { ...baseContent, timeline: [{ time: "10:00", title: "集合", text: "", photoObjectKey: "photo-b" }], meetingPoint: { entranceNote: "合成の入口", exteriorPhotoObjectKey: "photo-b" } } });
  const server = newServer(detail);
  await serve(page, server, ({ patch }) => { server.page = { ...applied(server.page, patch), photos: server.page.photos.filter((photo) => patch.photoObjectKeys!.includes(photo.objectKey)), photoAlts: patch.photoAlts ?? [] }; });
  await open(page);
  await expect(page.getByLabel("当日の流れ 1 の写真")).toHaveValue("photo-b");
  await expect(page.getByLabel("外観写真", { exact: true })).toHaveValue("photo-b");
  await page.getByRole("button", { name: "写真 2 を外す" }).click();
  await expect(page.getByLabel("当日の流れ 1 の写真")).toHaveValue("");
  await expect(page.getByLabel("外観写真", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  const [sent] = server.patches;
  expect(sent!.patch.photoObjectKeys).toEqual(["photo-a"]);
  expect(sent!.patch.content!.timeline).toEqual([{ time: "10:00", title: "集合", text: "", photoObjectKey: null }]);
  expect(sent!.patch.content!.meetingPoint).toEqual({ entranceNote: "合成の入口", exteriorPhotoObjectKey: null });
});

test("against the mock NIHO: a Japanese draft's English tab reads what NIHO made and says what it has not", async ({ page }) => {
  await page.goto("/host/auth/mock-login");
  await page.goto("/host/experiences/sample-page-kitchen-market?providerId=sample-provider-kitchen");
  await expect(page.getByLabel("題名", { exact: true })).toHaveValue("（サンプル）朝市で買って、台所で作る");
  await expect(page.getByRole("textbox", { name: "ひとこと紹介" })).toHaveValue("（サンプル）朝市で野菜を選び、台所で一緒に料理します。合成データです。");
  await expect(page.getByLabel("当日の流れ 2 の題")).toHaveValue("（サンプル）台所で調理");

  // The synthetic NIHO made English for some items only, and says which (the preview's `*En`, read through the BFF).
  const english = page.getByRole("tab", { name: /英語（自動訳）/ });
  await expect(english).toContainText("一部のみ");
  await english.click();
  await expect(page.getByRole("region", { name: "英語の題名" })).toContainText("(Sample) Shop at the morning market, cook in the kitchen");
  const highlights = page.getByRole("region", { name: "見どころ", exact: true });
  await expect(highlights).toContainText("(Sample) Choose seasonal vegetables at the market");
  await expect(highlights).toContainText("日本語: （サンプル）できた料理をみんなで味わう");
  const timeline = page.getByRole("region", { name: "当日の流れ", exact: true });
  await expect(timeline).toContainText("(Sample) Shopping at the market");
  await expect(timeline).toContainText("日本語: （サンプル）台所で調理");
  await expect(page.getByRole("region", { name: "英語の状態" })).toContainText("英語がまだない項目があります。");
  await page.getByRole("tab", { name: "日本語で書く" }).click();
  await expect(page.getByRole("textbox", { name: "ひとこと紹介" })).toBeVisible();
  await noOverflow(page); await axeSerious(page);
});
