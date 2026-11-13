import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "../src/errors.ts";
import { GroupInquiryRepository, GROUP_INQUIRY_MAIL_LIMITS } from "../src/group-inquiries.ts";
import { GROUP_INQUIRY_LIMITS, addBusinessDays, checkGroupInquiry } from "../src/group-inquiry-fields.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** 団体・個別の相談 (#532, migration 0074): the inquiry, its two emails and the office's list, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = "adm_00000000000000000000000000000001";
const KEY = (n: number) => `inquiry-key-${String(n).padStart(4, "0")}`;
const REF = /^IQ-[0-9A-HJKMNP-TV-Z]{8}$/;

async function withInquiries(run: (context: { readonly pool: Pool; readonly inquiries: GroupInquiryRepository }) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "group_inquiries", { max: 4 });
  try {
    await run({ pool: db.pool, inquiries: new GroupInquiryRepository(db.pool) });
  } finally {
    await db.dispose();
  }
}

const minimal = (n: number, extra: Record<string, unknown> = {}) => ({
  kind: "SCHOOL", locale: "ja", name: "山田 花子", email: `sample${n}@example.com`, message: "修学旅行で体験を探しています。", clientRequestKey: KEY(n), ...extra,
});

describe("checkGroupInquiry (no database)", () => {
  it("needs only a name, an address and a message; every other answer may be left out", () => {
    const ok = checkGroupInquiry({ kind: "CORPORATE", name: " 佐藤 ", email: "a@example.com", message: " 相談です " });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.value.name, "佐藤");
      assert.equal(ok.value.message, "相談です");
      assert.deepEqual(ok.value.details, {});
      assert.equal(ok.value.entry, "DIRECT");
    }
    assert.deepEqual(checkGroupInquiry({ kind: "CORPORATE", name: "", email: "a@example.com", message: "x" }), { ok: false, problem: "name" });
    assert.deepEqual(checkGroupInquiry({ kind: "CORPORATE", name: "a", email: "not-an-address", message: "x" }), { ok: false, problem: "email" });
    assert.deepEqual(checkGroupInquiry({ kind: "CORPORATE", name: "a", email: "a@example.com", message: "   " }), { ok: false, problem: "message" });
    assert.deepEqual(checkGroupInquiry({ kind: "OTHER", name: "a", email: "a@example.com", message: "x" }), { ok: false, problem: "kind" });
  });

  it("keeps only the kind's own answers, and tells a choice outside its list from a left-out one", () => {
    const school = checkGroupInquiry({
      kind: "SCHOOL", name: "a", email: "a@example.com", message: "x",
      details: { organization: "サンプル中学校", grade: " 中学2年 ", payer: "UNDECIDED", budget: "3000円", budgetUnit: "PER_PERSON", purpose: "学校には無い項目", people: "" },
    });
    assert.equal(school.ok, true);
    if (school.ok) assert.deepEqual(school.value.details, { organization: "サンプル中学校", grade: "中学2年", payer: "UNDECIDED", budget: "3000円", budgetUnit: "PER_PERSON" });
    assert.deepEqual(checkGroupInquiry({ kind: "SCHOOL", name: "a", email: "a@example.com", message: "x", details: { payer: "CASH" } }), { ok: false, problem: "details.payer" });
    assert.deepEqual(checkGroupInquiry({ kind: "SCHOOL", name: "a", email: "a@example.com", message: "x", details: { budgetUnit: "EACH" } }), { ok: false, problem: "details.budgetUnit" });
    assert.deepEqual(checkGroupInquiry({ kind: "PERSONAL", name: "a", email: "a@example.com", message: "x", details: { people: "a".repeat(61) } }), { ok: false, problem: "details.people" });
  });

  it("drops a tracking value that is not clean instead of refusing the inquiry, and refuses an experience slug that is not one", () => {
    const ok = checkGroupInquiry({ kind: "PERSONAL", name: "a", email: "a@example.com", message: "x", utmSource: "News Letter!", utmMedium: "email" });
    assert.equal(ok.ok && ok.value.utmSource, null);
    assert.equal(ok.ok && ok.value.utmMedium, "email");
    assert.deepEqual(checkGroupInquiry({ kind: "PERSONAL", name: "a", email: "a@example.com", message: "x", experienceSlug: "has space" }), { ok: false, problem: "experience" });
    assert.deepEqual(checkGroupInquiry({ kind: "PERSONAL", name: "a", email: "a@example.com", message: "x", entry: "ELSEWHERE" }), { ok: false, problem: "entry" });
  });

  it("counts two business days over a weekend", () => {
    assert.equal(addBusinessDays("2026-11-13", 2), "2026-11-17"); // Friday -> Tuesday
    assert.equal(addBusinessDays("2026-11-11", 2), "2026-11-13");
  });
});

describe("GroupInquiryRepository", { skip: databaseUrl ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("keeps an inquiry with only the three required answers and queues the office's notice and the sender's receipt", async () => {
    await withInquiries(async ({ pool, inquiries }) => {
      const result = await inquiries.submit(minimal(1));
      assert.match(result.inquiryRef, REF);
      assert.equal(result.repeated, false);
      assert.match(result.replyByDate, /^\d{4}-\d{2}-\d{2}$/);
      const mails = await pool.query("SELECT recipient, status, attempts FROM group_inquiry_mails ORDER BY recipient");
      assert.deepEqual(mails.rows, [{ recipient: "SENDER", status: "PENDING", attempts: 0 }, { recipient: "STAFF", status: "PENDING", attempts: 0 }]);
      const list = await inquiries.list();
      assert.equal(list.inquiries.length, 1);
      const [record] = list.inquiries;
      assert.equal(record!.status, "NEW");
      assert.equal(record!.nextDueOn, result.replyByDate);
      assert.deepEqual(record!.details, {});
      assert.equal(record!.staffMail, "PENDING");
      assert.deepEqual(list.counts, { NEW: 1, IN_PROGRESS: 0, DONE: 0 });
      // An inquiry is not a booking: no table of sales or inventory was touched by it.
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM booking_guests")).rows[0]!.n, 0);
    });
  });

  it("is idempotent on the browser's key: the same submission sent twice is one inquiry and one pair of emails", async () => {
    await withInquiries(async ({ pool, inquiries }) => {
      const first = await inquiries.submit(minimal(2));
      const [again, third] = await Promise.all([inquiries.submit(minimal(2)), inquiries.submit(minimal(2))]);
      assert.equal(again.inquiryRef, first.inquiryRef);
      assert.equal(third.inquiryRef, first.inquiryRef);
      assert.equal(again.repeated, true);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM group_inquiries")).rows[0]!.n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM group_inquiry_mails")).rows[0]!.n, 2);
    });
  });

  it("limits one address, answers a repeated key before the limit, and counts everyone's in an hour", async () => {
    await withInquiries(async ({ inquiries }) => {
      for (let n = 1; n <= GROUP_INQUIRY_LIMITS.perEmailPerHour; n += 1) await inquiries.submit(minimal(n, { email: "same@example.com" }));
      await assert.rejects(() => inquiries.submit(minimal(10, { email: "SAME@example.com" })), (error: unknown) => error instanceof StoreRateLimitedError && error.retryAfterSeconds >= 1);
      assert.equal((await inquiries.submit(minimal(1, { email: "same@example.com" }))).repeated, true);
      // Another address is not held back by it.
      assert.equal((await inquiries.submit(minimal(11, { email: "other@example.com" }))).repeated, false);
    });
  });

  it("refuses what the form would not have sent", async () => {
    await withInquiries(async ({ inquiries }) => {
      await assert.rejects(() => inquiries.submit(minimal(1, { email: "nope" })), StoreValidationError);
      await assert.rejects(() => inquiries.submit(minimal(1, { clientRequestKey: "short" })), StoreValidationError);
      await assert.rejects(() => inquiries.submit(minimal(1, { details: { payer: "CASH" } })), StoreValidationError);
    });
  });

  it("keeps the interest and the entry the page knew, and the kind's own answers", async () => {
    await withInquiries(async ({ inquiries }) => {
      await inquiries.submit(minimal(3, {
        entry: "EXPERIENCE", experienceSlug: "tea-ceremony", experienceTitle: "Tea at a temple", hostName: "Sato",
        utmSource: "newsletter", details: { organization: "サンプル中学校", payer: "TRAVEL_AGENCY", budget: "5000円", budgetUnit: "TOTAL" },
      }));
      const [record] = (await inquiries.list()).inquiries;
      assert.equal(record!.entry, "EXPERIENCE");
      assert.equal(record!.experienceSlug, "tea-ceremony");
      assert.equal(record!.experienceTitle, "Tea at a temple");
      assert.equal(record!.hostName, "Sato");
      assert.equal(record!.utmSource, "newsletter");
      assert.deepEqual(record!.details, { organization: "サンプル中学校", payer: "TRAVEL_AGENCY", budget: "5000円", budgetUnit: "TOTAL" });
    });
  });

  it("claims each email once with a lease, sends the office's notice first, and reports SENT / RETRY / FAILED", async () => {
    await withInquiries(async ({ pool, inquiries }) => {
      const { inquiryRef } = await inquiries.submit(minimal(4));
      const claimed = await inquiries.claimMails({ limit: 10, leaseSeconds: 120 });
      assert.deepEqual(claimed.map((mail) => mail.recipient), ["STAFF", "SENDER"]);
      assert.equal(claimed[0]!.inquiryRef, inquiryRef);
      assert.equal(claimed[0]!.contactEmail, "sample4@example.com");
      assert.equal(claimed[0]!.attempts, 1);
      // Leased: another worker claims nothing.
      assert.deepEqual(await inquiries.claimMails({ limit: 10, leaseSeconds: 120 }), []);
      assert.equal(await inquiries.recordMail(claimed[0]!.inquiryId, "STAFF", "SENT"), "SENT");
      assert.equal(await inquiries.recordMail(claimed[1]!.inquiryId, "SENDER", "RETRY"), "PENDING");
      // The retry waits (2 minutes after the first attempt).
      assert.deepEqual(await inquiries.claimMails({ limit: 10, leaseSeconds: 120 }), []);
      const [record] = (await inquiries.list()).inquiries;
      assert.equal(record!.staffMail, "SENT");
      assert.equal(record!.senderMail, "PENDING");
      // A SENT email is not reported on again as failed.
      assert.equal(await inquiries.recordMail(claimed[0]!.inquiryId, "STAFF", "FAILED"), "SENT");
      await pool.query("UPDATE group_inquiry_mails SET lease_until = clock_timestamp() - interval '1 second' WHERE recipient = 'SENDER'");
      const retried = await inquiries.claimMails({ limit: 10, leaseSeconds: 120 });
      assert.equal(retried.length, 1);
      assert.equal(retried[0]!.attempts, 2);
      assert.equal(await inquiries.recordMail(retried[0]!.inquiryId, "SENDER", "FAILED"), "FAILED");
      assert.equal((await inquiries.list()).inquiries[0]!.senderMail, "FAILED");
    });
  });

  it("gives up after the attempts, and closes a last attempt whose lease ran out", async () => {
    await withInquiries(async ({ pool, inquiries }) => {
      await inquiries.submit(minimal(5));
      for (let attempt = 1; attempt < GROUP_INQUIRY_MAIL_LIMITS.attempts; attempt += 1) {
        const [mail] = await inquiries.claimMails({ limit: 1, leaseSeconds: 30 });
        assert.equal(mail!.attempts, attempt);
        assert.equal(await inquiries.recordMail(mail!.inquiryId, mail!.recipient, "RETRY"), "PENDING");
        await pool.query("UPDATE group_inquiry_mails SET lease_until = NULL WHERE inquiry_id = $1", [mail!.inquiryId]);
        await pool.query("UPDATE group_inquiry_mails SET attempts = 0 WHERE recipient = 'SENDER'");
      }
      const [last] = await inquiries.claimMails({ limit: 1, leaseSeconds: 30 });
      assert.equal(last!.attempts, GROUP_INQUIRY_MAIL_LIMITS.attempts);
      assert.equal(await inquiries.recordMail(last!.inquiryId, last!.recipient, "RETRY"), "FAILED");
      await pool.query("UPDATE group_inquiry_mails SET status = 'SENDING', lease_until = clock_timestamp() - interval '1 second' WHERE recipient = 'SENDER'");
      await pool.query("UPDATE group_inquiry_mails SET attempts = $1 WHERE recipient = 'SENDER'", [GROUP_INQUIRY_MAIL_LIMITS.attempts]);
      await inquiries.claimMails({ limit: 5, leaseSeconds: 30 });
      assert.equal((await pool.query("SELECT status FROM group_inquiry_mails WHERE recipient = 'SENDER'")).rows[0]!.status, "FAILED");
    });
  });

  it("lists open inquiries first, overdue ones leading, and filters by status", async () => {
    await withInquiries(async ({ inquiries }) => {
      const a = await inquiries.submit(minimal(21));
      await inquiries.submit(minimal(22));
      await inquiries.submit(minimal(23));
      const all = (await inquiries.list()).inquiries;
      const ids = Object.fromEntries(all.map((record) => [record.inquiryRef, record.id]));
      await inquiries.update(ADMIN, ids[a.inquiryRef]!, { status: "DONE" });
      const sorted = (await inquiries.list()).inquiries;
      assert.equal(sorted.at(-1)!.inquiryRef, a.inquiryRef);
      assert.equal((await inquiries.list({ status: "DONE" })).inquiries.length, 1);
      assert.equal((await inquiries.list({ status: "NEW" })).inquiries.length, 2);
      assert.deepEqual((await inquiries.list()).counts, { NEW: 2, IN_PROGRESS: 0, DONE: 1 });
      await assert.rejects(() => inquiries.list({ status: "ARCHIVED" }), StoreValidationError);
    });
  });

  it("edits the office's side by hand and keeps the last editor, clearing a field with null", async () => {
    await withInquiries(async ({ inquiries }) => {
      await inquiries.submit(minimal(30));
      const [record] = (await inquiries.list()).inquiries;
      const updated = await inquiries.update(ADMIN, record!.id, { status: "IN_PROGRESS", assigneeLabel: " 高橋 ", nextDueOn: "2026-12-01", staffNote: "電話の日程を調整中\n来週" });
      assert.equal(updated.status, "IN_PROGRESS");
      assert.equal(updated.assigneeLabel, "高橋");
      assert.equal(updated.nextDueOn, "2026-12-01");
      assert.equal(updated.staffNote, "電話の日程を調整中\n来週");
      assert.equal(updated.updatedByActor, ADMIN);
      // A field left out stays; null clears.
      const cleared = await inquiries.update(ADMIN, record!.id, { staffNote: null, nextDueOn: null });
      assert.equal(cleared.staffNote, null);
      assert.equal(cleared.nextDueOn, null);
      assert.equal(cleared.assigneeLabel, "高橋");
      assert.equal(cleared.status, "IN_PROGRESS");
      await assert.rejects(() => inquiries.update(ADMIN, record!.id, { status: "WON" }), StoreValidationError);
      await assert.rejects(() => inquiries.update(ADMIN, record!.id, { nextDueOn: "2026-13-45" }), StoreValidationError);
      await assert.rejects(() => inquiries.update(ADMIN, record!.id, {}), StoreValidationError);
      await assert.rejects(() => inquiries.update(ADMIN, "00000000-0000-4000-8000-000000000000", { status: "DONE" }), StoreNotFoundError);
    });
  });
});
