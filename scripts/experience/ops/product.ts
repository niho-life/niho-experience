import { createHash } from "node:crypto";
import { parseScheduleRule } from "@niho-experience/experience-domain";
import { EXIT, OpsError, errorCode, failureOf, operationId, sendOnce, writeOne, type Action, type ApiResponse, type Context, type Target } from "./core.ts";

/*
 * 商品の原稿・販売条件・公開 (#576 ④) from the command line: the Admin's seller workspaces (`/admin/api/product-workspaces`,
 * the 事務局の代理登録). Every change carries the revision the product had when this run read it, so one that somebody changed
 * meanwhile is refused (409 VERSION_CONFLICT) and nothing is overwritten. The server's own validation and publication
 * blockers decide what can be published; the CLI never writes to the database.
 */

const ROOT = "/admin/api/product-workspaces";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const enc = encodeURIComponent;

export interface ProductDto {
  readonly id: string;
  readonly version: string;
  readonly publicationBlockers?: readonly string[];
  readonly acceptanceMode?: string;
  readonly adminEnglishReview?: unknown;
  readonly draft: { readonly slug: string; readonly publicTitle: string; readonly content: Record<string, unknown>; readonly currency: string; readonly unitAmount: number };
  readonly sellerDisplayName?: string;
  readonly saleTerms: Record<string, unknown> | null;
  readonly offers?: readonly unknown[];
  readonly media?: ReadonlyArray<{ readonly id: string; readonly altText?: string; readonly altTextJa?: string; readonly publicCredit?: string | null }>;
}

function need(context: Context, flag: "provider" | "product"): string {
  const value = context.args.flags[flag];
  if (typeof value !== "string" || !ID.test(value)) throw new OpsError("usage", `--${flag} <id> is required.`, EXIT.usage);
  return value;
}

function bodyOf(response: ApiResponse, action: string): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) throw productFailure(response, action);
  return isRecord(response.body) ? response.body : {};
}

const productFailure = failureOf;

async function readProduct(context: Context, providerId: string, productId: string): Promise<ProductDto> {
  const body = bodyOf(await context.api.get(`${ROOT}/${enc(providerId)}/products/${enc(productId)}`), "product show");
  if (!isRecord(body.product)) throw new OpsError("unexpected_response", "The product was not understood.");
  return body.product as unknown as ProductDto;
}

const summary = (product: ProductDto) => ({
  id: product.id, revision: product.version, slug: product.draft.slug, publicTitle: product.draft.publicTitle, unitAmount: product.draft.unitAmount,
  japaneseOnly: product.draft.content.japaneseOnly === true, blockers: product.publicationBlockers ?? [], mediaCount: product.media?.length ?? 0,
  hasSaleTerms: product.saleTerms !== null, acceptanceMode: product.acceptanceMode ?? null,
});

const list: Action = {
  tier: "read",
  summary: "Lists a provider's products (--provider <providerId>): slug, title, price, blockers that stop publication, photo count.",
  async run(context) {
    const providerId = need(context, "provider");
    const body = bodyOf(await context.api.get(`${ROOT}/${enc(providerId)}/products`), "product list");
    const products = Array.isArray(body.products) ? (body.products as ProductDto[]) : [];
    return { count: products.length, products: products.map(summary), publicationConsentVersion: body.publicationConsentVersion ?? null };
  },
};

const show: Action = {
  tier: "read",
  summary: "One product's draft (content included), sale terms, offers and photos (--provider, --product), with the revision a change must carry.",
  async run(context) {
    const product = await readProduct(context, need(context, "provider"), need(context, "product"));
    return { ...summary(product), draft: product.draft, saleTerms: product.saleTerms, offers: product.offers ?? [], media: product.media ?? [], adminEnglishReview: product.adminEnglishReview ?? null };
  },
};

const create: Action = {
  tier: "edit",
  summary: 'Creates a draft product for a provider (--provider, --file {"slug","publicTitle","content","unitAmount","managedSales"?}). Currency is JPY. Nothing is published.',
  async run(context) {
    const providerId = need(context, "provider");
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <draft.json> is required.", EXIT.usage);
    const text = context.readFile(file);
    let draft: unknown;
    try { draft = JSON.parse(text); } catch { throw new OpsError("invalid_file", "The draft file is not JSON."); }
    if (!isRecord(draft)) throw new OpsError("invalid_file", "The draft file must be an object.");
    const extra = Object.keys(draft).filter((key) => !["slug", "publicTitle", "content", "unitAmount", "managedSales"].includes(key));
    if (extra.length > 0) throw new OpsError("invalid_file", `Unknown key: ${extra[0]}.`);
    for (const key of ["slug", "publicTitle", "content", "unitAmount"]) if (draft[key] === undefined) throw new OpsError("invalid_file", `${key} is required.`);
    const body = { ...draft, currency: "JPY" };
    const existing = bodyOf(await context.api.get(`${ROOT}/${enc(providerId)}/products`), "product list");
    const found = (Array.isArray(existing.products) ? (existing.products as ProductDto[]) : []).find((product) => product.draft.slug === draft.slug);
    if (found) return { status: "unchanged", product: summary(found), note: "A product with this slug already exists for the provider; use `product draft` to change it." };
    if (!context.apply) return { status: "dry_run", create: body };
    const seed = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const sent = await sendOnce(context, [seed, "product-create", providerId], (operationId) => context.api.send("POST", `${ROOT}/${enc(providerId)}/products`, body, operationId), async () => {
      const again = bodyOf(await context.api.get(`${ROOT}/${enc(providerId)}/products`), "product list");
      return (Array.isArray(again.products) ? (again.products as ProductDto[]) : []).find((product) => product.draft.slug === draft.slug) ?? null;
    });
    if ("done" in sent) return { status: "unchanged", product: summary(sent.done) };
    const response = sent.response;
    const created = bodyOf(response, "product create");
    return { status: "applied", product: isRecord(created.product) ? summary(created.product as unknown as ProductDto) : null };
  },
};

interface DraftState { readonly slug: string; readonly publicTitle: string; readonly content: Record<string, unknown> }

const draftAction: Action = {
  tier: "edit",
  summary: "Changes a product's draft: slug, publicTitle and content (--provider, --product, --file {\"publicTitle\"?,\"slug\"?,\"content\"?}). `content` is merged by top-level key (`ja` replaces the whole Japanese manuscript). The price is `product terms`.",
  async run(context) {
    const providerId = need(context, "provider");
    const productId = need(context, "product");
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <draft-changes.json> is required.", EXIT.usage);
    const text = context.readFile(file);
    let given: unknown;
    try { given = JSON.parse(text); } catch { throw new OpsError("invalid_file", "The file is not JSON."); }
    if (!isRecord(given) || Object.keys(given).length === 0) throw new OpsError("invalid_file", "The file must be an object with slug, publicTitle and/or content.");
    const extra = Object.keys(given).filter((key) => !["slug", "publicTitle", "content"].includes(key));
    if (extra.length > 0) throw new OpsError("invalid_file", `${extra[0]} is not changed here (the price and sale terms are \`product terms\`).`);
    if (given.content !== undefined && !isRecord(given.content)) throw new OpsError("invalid_file", "content must be an object.");
    let product: ProductDto | null = null;
    const seed = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const result = await writeOne<DraftState>(context, [seed, "product-draft", providerId, productId], {
      key: `${providerId}/${productId}`,
      read: async () => { product = await readProduct(context, providerId, productId); const { slug, publicTitle, content } = product.draft; return { slug, publicTitle, content }; },
      desired: (current) => ({ slug: (given.slug as string | undefined) ?? current.slug, publicTitle: (given.publicTitle as string | undefined) ?? current.publicTitle, content: { ...current.content, ...(given.content as Record<string, unknown> | undefined) } }),
      send: async (_current, desired, operationId) => context.api.send("PATCH", `${ROOT}/${enc(providerId)}/products/${enc(productId)}`, { version: product!.version, draft: { ...desired, currency: product!.draft.currency, unitAmount: product!.draft.unitAmount } }, operationId),
    });
    if (result.status === "failed") throw new OpsError(result.error ?? "failed", "The draft was not changed.", result.error === "version_conflict" ? EXIT.conflict : EXIT.failed, { result });
    return result;
  },
};

interface TermsState { readonly unitAmount: number; readonly saleTerms: Record<string, unknown> | null }

const terms: Action = {
  tier: "terms",
  summary: "Changes the price and/or sale terms (--provider, --product, --file {\"unitAmount\"?,\"saleTerms\"?}). `saleTerms` is merged by top-level key onto the current terms (a product without terms needs the whole object: see `product show`). Booked orders keep their terms.",
  async run(context) {
    const providerId = need(context, "provider");
    const productId = need(context, "product");
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <terms.json> is required.", EXIT.usage);
    const text = context.readFile(file);
    let given: unknown;
    try { given = JSON.parse(text); } catch { throw new OpsError("invalid_file", "The file is not JSON."); }
    if (!isRecord(given) || Object.keys(given).length === 0 || Object.keys(given).some((key) => key !== "unitAmount" && key !== "saleTerms")) throw new OpsError("invalid_file", "The file must be an object with unitAmount and/or saleTerms.");
    if (given.saleTerms !== undefined && !isRecord(given.saleTerms)) throw new OpsError("invalid_file", "saleTerms must be an object.");
    let product: ProductDto | null = null;
    const seed = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const result = await writeOne<TermsState>(context, [seed, "product-terms", providerId, productId], {
      key: `${providerId}/${productId}`,
      read: async () => { product = await readProduct(context, providerId, productId); return { unitAmount: product.draft.unitAmount, saleTerms: product.saleTerms }; },
      desired: (current) => ({ unitAmount: (given.unitAmount as number | undefined) ?? current.unitAmount, saleTerms: given.saleTerms === undefined ? current.saleTerms : { ...(current.saleTerms ?? {}), ...(given.saleTerms as Record<string, unknown>) } }),
      send: async (current, desired, operationId) => {
        let version = product!.version;
        if (desired.unitAmount !== current.unitAmount) {
          const { slug, publicTitle, content, currency } = product!.draft;
          const patched = await context.api.send("PATCH", `${ROOT}/${enc(providerId)}/products/${enc(productId)}`, { version, draft: { slug, publicTitle, content, currency, unitAmount: desired.unitAmount } }, `${operationId}-a`);
          if (patched.status < 200 || patched.status >= 300) return patched;
          const next = isRecord(patched.body) && isRecord(patched.body.product) ? patched.body.product.version : undefined;
          if (typeof next !== "string") throw new OpsError("unexpected_response", "The new revision was not returned.");
          version = next;
        }
        if (JSON.stringify(desired.saleTerms) === JSON.stringify(current.saleTerms)) return { status: 200, body: {} };
        return context.api.send("PUT", `${ROOT}/${enc(providerId)}/products/${enc(productId)}/sale-terms`, { version, saleTerms: desired.saleTerms }, `${operationId}-b`);
      },
    });
    if (result.status === "failed") throw new OpsError(result.error ?? "failed", "The price and terms were not changed completely; read the product again.", result.error === "version_conflict" ? EXIT.conflict : EXIT.failed, { result });
    return result;
  },
};

const publish: Action = {
  tier: "publish",
  summary: "Publishes the draft as it is (--provider, --product, --seller-confirmation VERBAL|WRITTEN). The server refuses while a blocker remains (see `product show`). Photos are only ever ones whose rights are cleared (the owner's rule), so the photo rights confirmation is sent as true.",
  async run(context) {
    const providerId = need(context, "provider");
    const productId = need(context, "product");
    const method = context.args.flags["seller-confirmation"];
    if (method !== "VERBAL" && method !== "WRITTEN") throw new OpsError("usage", "--seller-confirmation VERBAL|WRITTEN is required (how the seller confirmed).", EXIT.usage);
    const listed = bodyOf(await context.api.get(`${ROOT}/${enc(providerId)}/products`), "product list");
    const consentVersion = typeof listed.publicationConsentVersion === "string" ? listed.publicationConsentVersion : null;
    if (!consentVersion) throw new OpsError("unexpected_response", "The publication consent version was not returned.");
    const product = await readProduct(context, providerId, productId);
    const blockers = product.publicationBlockers ?? [];
    if (!context.apply) return { status: "dry_run", blockers, wouldPublish: blockers.length === 0, product: summary(product) };
    if (blockers.length > 0) throw new OpsError("publication_blocked", "The server lists blockers: fix them first.", EXIT.failed, { blockers });
    const sent = await sendOnce(context, ["publish", providerId, productId, product.version], (operationId) => context.api.send("POST", `${ROOT}/${enc(providerId)}/products/${enc(productId)}/publish`, { version: product.version, accepted: true, sellerConfirmationMethod: method, photoRightsConfirmed: true, consentVersion }, operationId), async () => {
      const after = await readProduct(context, providerId, productId);
      return after.version === product.version ? null : summary(after);
    });
    if ("done" in sent) return { status: "unchanged", note: "The product changed after this publish was sent; its state is below.", product: sent.done };
    const response = sent.response;
    const published = bodyOf(response, "product publish");
    return { status: "applied", publication: published.publication ?? null };
  },
};


/** A UUID v4-shaped command ID derived from what the command means, so the same rule sent again is recognised (the server answers 200 instead of 201). */
export function stableCommandId(...parts: readonly string[]): string {
  const bytes = createHash("sha256").update(parts.join("\u0000")).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const calendar: Action = {
  tier: "read",
  summary: "The product's schedule rules and the dates they make (--provider, --product, --from YYYY-MM-DD --to YYYY-MM-DD; at most 90 days, default today and 60 days on).",
  async run(context) {
    const providerId = need(context, "provider");
    const productId = need(context, "product");
    const day = (offset: number) => new Date(context.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const from = typeof context.args.flags.from === "string" ? context.args.flags.from : day(0);
    const to = typeof context.args.flags.to === "string" ? context.args.flags.to : day(60);
    if (!DATE.test(from) || !DATE.test(to)) throw new OpsError("usage", "--from and --to are YYYY-MM-DD.", EXIT.usage);
    const response = await context.api.get(`${ROOT}/${enc(providerId)}/products/${enc(productId)}/calendar?providerId=${enc(providerId)}&fromDate=${from}&toDate=${to}`);
    const body = bodyOf(response, "product calendar");
    const occurrences = Array.isArray(body.occurrences) ? body.occurrences : [];
    return { range: { from, to }, rules: body.rules ?? [], occurrenceCount: occurrences.length, occurrences: occurrences.slice(0, 200) };
  },
};

const calendarAdd: Action = {
  tier: "edit",
  summary: "Adds a schedule rule (a time slot that repeats) to the draft (--provider, --product, --file rule.json: timeZone Asia/Tokyo, startsOn, endsOn?, localStartTime, durationMinutes, capacity, bookingCutoffMinutes, busyBufferBeforeMinutes, busyBufferAfterMinutes, recurrence {kind: DAILY|WEEKLY|WEEKENDS|SELECTED_WEEKDAYS, weekdays?}). The same rule sent again changes nothing.",
  async run(context) {
    const providerId = need(context, "provider");
    const productId = need(context, "product");
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <rule.json> is required.", EXIT.usage);
    const text = context.readFile(file);
    let rule: unknown;
    try { rule = JSON.parse(text); } catch { throw new OpsError("invalid_file", "The rule file is not JSON."); }
    if (!isRecord(rule)) throw new OpsError("invalid_file", "The rule file must be an object.");
    const commandId = stableCommandId("calendar-rule", providerId, productId, JSON.stringify(Object.fromEntries(Object.entries(rule).sort(([a], [b]) => (a < b ? -1 : 1)))));
    try { parseScheduleRule({ ...rule, id: commandId }); } catch (error) { throw new OpsError("invalid_rule", error instanceof Error ? error.message : "The rule is invalid."); }
    if (!context.apply) return { status: "dry_run", commandId, rule };
    const day = new Date(context.now()).toISOString().slice(0, 10).replaceAll("-", "");
    const response = await context.api.send("POST", `${ROOT}/${enc(providerId)}/products/${enc(productId)}/calendar`, { providerId, action: "createRule", experienceId: productId, rule, commandId }, `op-${day}-${commandId.replaceAll("-", "").slice(0, 12)}`);
    if (response.status === 409 && errorCode(response.body) === "operation_already_recorded") return { status: "unchanged", commandId, note: "This rule was already sent; `product calendar` shows it." };
    const saved = bodyOf(response, "product calendar-add");
    return { status: response.status === 201 ? "applied" : "unchanged", commandId, ruleId: saved.id ?? null, version: saved.version ?? null };
  },
};

const IMAGE_TYPES: Readonly<Record<string, string>> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

const photoAdd: Action = {
  tier: "edit",
  summary: "Uploads a photo to the draft's gallery (--provider, --product, --file image.jpg|png, --alt <English alt text>, --alt-ja <日本語の説明>; --credit <public credit> optional; --again to upload the same file once more). Only photos whose rights are already cleared (the owner's rule, 2026-11-14): the upload sends the rights confirmation the server asks for, so no input is needed. The file's sha256 is printed.",
  async run(context) {
    const providerId = need(context, "provider");
    const productId = need(context, "product");
    const flags = context.args.flags;
    const file = flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <image.jpg|png> is required.", EXIT.usage);
    const type = IMAGE_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()];
    if (!type) throw new OpsError("usage", "The photo must be .jpg, .jpeg or .png.", EXIT.usage);
    const text = (name: string): string => {
      const value = flags[name];
      if (typeof value !== "string" || value.trim() === "" || value.length > 500) throw new OpsError("usage", `--${name} <text> is required (up to 500 characters).`, EXIT.usage);
      return value;
    };
    const alt = text("alt");
    const altJa = text("alt-ja");
    const credit = typeof flags.credit === "string" ? flags.credit : null;
    if (credit !== null && (credit.trim() === "" || credit.length > 300)) throw new OpsError("usage", "--credit must be 1-300 characters.", EXIT.usage);
    const bytes = context.readBytes(file);
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new OpsError("invalid_file", "The photo must be 1 byte to 10 MB.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const evidence = { sha256, publicCredit: credit };
    if (!context.apply) return { status: "dry_run", photo: { bytes: bytes.byteLength, contentType: type, alt, altJa }, evidence };
    const headers: Record<string, string> = {
      "x-experience-photo-rights-confirmed": "true", "x-experience-media-placement": "GALLERY",
      "x-experience-photo-alt-text-utf8-base64url": b64url(alt), "x-experience-photo-alt-text-ja-utf8-base64url": b64url(altJa),
      ...(credit !== null ? { "x-experience-photo-credit-utf8-base64url": b64url(credit) } : {}),
    };
    const seed = ["photo", providerId, productId, sha256, ...(flags.again === true ? [String(context.now())] : [])];
    const response = await context.api.send("POST", `${ROOT}/${enc(providerId)}/products/${enc(productId)}/media`, undefined, operationId(seed, 1, context.now()), { bytes, contentType: type, headers });
    if (response.status === 409 && errorCode(response.body) === "operation_already_recorded") return { status: "unchanged", evidence, note: "This photo was already sent for this product; `product show` lists the photos. Use --again to upload it once more." };
    const created = bodyOf(response, "product photo-add");
    return { status: "applied", evidence, media: isRecord(created.product) ? (created.product as unknown as ProductDto).media ?? [] : [] };
  },
};

/** The publication state version inside a product's revision token (`1:<draft>:<state>:<terms>`), or null before it was ever published. */
export function stateVersionOf(revision: string): number | null {
  const parts = Buffer.from(revision, "base64url").toString("utf8").split(":");
  const state = Number(parts[2]);
  return parts.length === 4 && Number.isSafeInteger(state) && state > 0 ? state : null;
}

const suspend: Action = {
  tier: "publish",
  summary: "Stops a published product (運営停止): --provider, --product, --reason <CODE, A-Z 0-9 _> (e.g. SYNTHETIC_CLEANUP). The owner must resume it afterwards; `resume` only lifts the suspension.",
  async run(context) {
    const providerId = need(context, "provider");
    const productId = need(context, "product");
    const reason = context.args.flags.reason;
    if (typeof reason !== "string" || !/^[A-Z0-9_]{1,80}$/.test(reason)) throw new OpsError("usage", "--reason <CODE> is required (capital letters, digits and _).", EXIT.usage);
    const product = await readProduct(context, providerId, productId);
    const stateVersion = stateVersionOf(product.version);
    if (stateVersion === null) return { status: "unchanged", note: "The product was never published, so there is nothing to stop.", product: summary(product) };
    if (!context.apply) return { status: "dry_run", wouldSuspend: { providerId, productId, reason, stateVersion } };
    const path = `/admin/api/experience-publications/providers/${enc(providerId)}/products/${enc(productId)}/suspend`;
    const response = await context.api.send("POST", path, { expectedStateVersion: stateVersion, reasonCode: reason }, operationId(["suspend", providerId, productId, String(stateVersion), reason], 1, context.now()));
    if (response.status === 409 && errorCode(response.body) === "operation_already_recorded") return { status: "unchanged", note: "This stop was already sent for this state; `product show` shows the state." };
    return { status: "applied", publication: bodyOf(response, "product suspend").publication ?? null };
  },
};

const resume: Action = {
  tier: "publish",
  summary: "Lifts an operations suspension (--provider, --product). The owner still has to resume a product they stopped or that needs their resume.",
  async run(context) {
    const providerId = need(context, "provider");
    const productId = need(context, "product");
    const product = await readProduct(context, providerId, productId);
    const stateVersion = stateVersionOf(product.version);
    if (stateVersion === null) return { status: "unchanged", note: "The product was never published.", product: summary(product) };
    if (!context.apply) return { status: "dry_run", wouldClearSuspension: { providerId, productId, stateVersion } };
    const path = `/admin/api/experience-publications/providers/${enc(providerId)}/products/${enc(productId)}/clear-suspension`;
    const response = await context.api.send("POST", path, { expectedStateVersion: stateVersion }, operationId(["resume", providerId, productId, String(stateVersion)], 1, context.now()));
    if (response.status === 409 && errorCode(response.body) === "operation_already_recorded") return { status: "unchanged", note: "This was already sent for this state." };
    return { status: "applied", publication: bodyOf(response, "product resume").publication ?? null };
  },
};

export const productTarget: Target = {
  summary: "Products: draft, price and sale terms, publishing (事務局の代理登録 / product workspaces)",
  actions: { list, show, create, draft: draftAction, terms, calendar, "calendar-add": calendarAdd, "photo-add": photoAdd, publish, suspend, resume },
};
