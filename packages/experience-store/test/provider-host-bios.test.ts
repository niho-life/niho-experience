import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import {
  HOST_BIO_CONSENT_VERSION,
  HOST_BIO_LIMITS,
  hostBioLength,
  hostBioTextIssue,
  normalizeHostBioText,
  validateHostBioInput,
  validateHostBioText,
} from "../src/host-bio-rules.ts";
import { hostBioSourceFingerprint } from "../src/provider-host-bios.ts";

describe("host bio rules", () => {
  it("normalizes line endings, surrounding whitespace and long blank runs", () => {
    assert.equal(normalizeHostBioText("  鎌倉で茶道を教えています。\r\n\r\n\r\n\r\n15年続けています。\r最後の行  "), "鎌倉で茶道を教えています。\n\n15年続けています。\n最後の行");
    assert.equal(normalizeHostBioText("　全角空白　"), "全角空白");
    assert.equal(normalizeHostBioText("段落1\n\n段落2"), "段落1\n\n段落2");
  });

  it("counts code points as PostgreSQL char_length does", () => {
    assert.equal(hostBioLength("𠮷野家"), 3);
    assert.equal(hostBioTextIssue("𠮷".repeat(HOST_BIO_LIMITS.ja), "ja"), null);
    assert.equal(hostBioTextIssue("あ".repeat(HOST_BIO_LIMITS.ja + 1), "ja"), "TOO_LONG");
    assert.equal(hostBioTextIssue("a".repeat(HOST_BIO_LIMITS.en), "en"), null);
    assert.equal(hostBioTextIssue("a".repeat(HOST_BIO_LIMITS.en + 1), "en"), "TOO_LONG");
  });

  it("rejects empty text and control characters other than LF", () => {
    assert.equal(hostBioTextIssue("", "ja"), "EMPTY");
    assert.throws(() => validateHostBioText(" \n\r\n ", "ja"), StoreValidationError);
    assert.throws(() => validateHostBioText("タブ\tを含む", "ja"), StoreValidationError);
    assert.throws(() => validateHostBioText("NUL\u0000", "en"), StoreValidationError);
    assert.throws(() => validateHostBioText("C1\u0085", "en"), StoreValidationError);
    assert.throws(() => validateHostBioText(42, "ja"), StoreValidationError);
    assert.equal(validateHostBioText("一行目\n二行目", "ja"), "一行目\n二行目");
  });

  it("requires the current consent version and keeps English optional", () => {
    assert.deepEqual(validateHostBioInput({ bioJa: " 紹介 ", bioEn: null, consentVersion: HOST_BIO_CONSENT_VERSION }), { bioJa: "紹介", bioEn: null, consentVersion: HOST_BIO_CONSENT_VERSION });
    assert.deepEqual(validateHostBioInput({ bioJa: "紹介", bioEn: " Intro\r\n", consentVersion: HOST_BIO_CONSENT_VERSION }).bioEn, "Intro");
    assert.throws(() => validateHostBioInput({ bioJa: "紹介", bioEn: null, consentVersion: "host-bio-consent-v0" }), StoreValidationError);
    assert.throws(() => validateHostBioInput({ bioJa: "紹介", bioEn: "", consentVersion: HOST_BIO_CONSENT_VERSION }), StoreValidationError);
  });

  it("fingerprints the normalized Japanese text as UTF-8 sha256 hex", () => {
    const expected = createHash("sha256").update("鎌倉の茶室から", "utf8").digest("hex");
    assert.equal(hostBioSourceFingerprint("鎌倉の茶室から"), expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
    assert.notEqual(hostBioSourceFingerprint("鎌倉の茶室から。"), expected);
  });

  it("keeps the DB limits equal to HOST_BIO_LIMITS and stores no history or receipt table", async () => {
    const migration = await readFile(new URL("../migrations/0062_provider_host_bios.sql", import.meta.url), "utf8");
    assert.match(migration, new RegExp(`char_length\\(bio_ja\\) BETWEEN 1 AND ${HOST_BIO_LIMITS.ja}`));
    assert.match(migration, new RegExp(`char_length\\(bio_en\\) BETWEEN 1 AND ${HOST_BIO_LIMITS.en}`));
    assert.equal([...migration.matchAll(/CREATE TABLE/g)].length, 1);
  });
});
