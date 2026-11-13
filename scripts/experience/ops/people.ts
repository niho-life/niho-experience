import { createHash } from "node:crypto";
import { validatePeopleListingInput } from "@niho-experience/experience-store";
import { EXIT, OpsError, failureOf, writeOne, type Action, type ApiResponse, type Context, type Target, type WriteResult } from "./core.ts";

/*
 * 街の人 (#564, #589, docs/people.md) from the command line: the Admin screen's `/admin/api/people`. A listing is a person who
 * belongs to a provider (provider × member account); it is named in a change file by its slug. Listing a person (or changing,
 * moving or withdrawing the row) shows or hides them on the public site at once, so the changes are `publish`-tier. A change
 * carries the version this run read (`expectedVersion`): one that changed meanwhile, or a slug somebody else took, is
 * refused with 409 and nothing is overwritten.
 */

const API = "/admin/api/people";
const FIELDS = ["slug", "nameJa", "roleJa", "areaJa", "quoteJa", "introJa", "sortOrder"] as const;
/** 街の人 → 体験 (#585): the products a person is met through. Names the way a product is named in the classification file. */
const PRODUCTS_API = "/admin/api/product-classifications";
const EXPERIENCES_MAX = 50;
/** 人物ページから本人へ送れるのは、本人のアカウントが提供者の現役のメンバー（オーナーか共同ホスト）である人だけ (#589)。 */
const NO_MEMBER_REASON = "本人のアカウントが提供者のメンバー（オーナー・共同ホスト）でないため非公開";
export interface ExperienceRef { readonly providerId: string; readonly productId: string }
interface ProductRef extends ExperienceRef { readonly slug: string }

export interface PersonRow {
  readonly key?: string;
  readonly providerId: string;
  readonly providerName?: string;
  readonly memberId?: string | null;
  /** The member's current role in the provider; null without a member, or when they are no longer a current OWNER or co-host (#589). */
  readonly memberRole?: "OWNER" | "COHOST" | null;
  readonly photoReady: boolean;
  readonly listing: (Record<(typeof FIELDS)[number], unknown> & {
    readonly id?: string;
    readonly version: number;
    readonly updatedAtUtc: string;
    readonly photo?: { readonly assetId: string; readonly altJa: string; readonly credit: string | null } | null;
    readonly experiences?: readonly (ExperienceRef & { readonly slug?: string })[];
  }) | null;
  readonly visible: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function listPeople(context: Context): Promise<readonly PersonRow[]> {
  const response = await context.api.get(API);
  if (response.status !== 200) throw failureOf(response, "people list");
  const people = (response.body as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) throw new OpsError("unexpected_response", "The people list was not understood.");
  return people as PersonRow[];
}

const fieldsOf = (listing: PersonRow["listing"]): Record<string, unknown> => listing
  ? {
    ...Object.fromEntries(FIELDS.map((field) => [field, listing[field] ?? null])),
    // The photo as the server takes it, when the listing has one.
    ...(listing.photo ? { photo: { assetId: listing.photo.assetId, altJa: listing.photo.altJa, credit: listing.photo.credit ?? null } } : {}),
    // The links as the server takes them (providerId and productId, in order), when the server says them.
    ...(Array.isArray(listing.experiences) ? { experiences: listing.experiences.map((link) => ({ providerId: link.providerId, productId: link.productId })) } : {}),
  }
  : {};

export interface PersonItem {
  readonly providerId: string;
  /** The member's host account id; null detaches the person; left out keeps the current member (none for a new listing). */
  readonly memberId?: string | null;
  readonly listing: Readonly<Record<string, unknown>>;
}

/**
 * `{ "items": [{ "providerId": "...", "memberId": "hst_...", "listing": { "slug": "...", "nameJa": "...", "roleJa": "...", "areaJa": "...", "sortOrder": 10 } }] }`
 * A listing is named by its `slug`; `providerId` is the provider the person belongs to (a listing is moved by giving another).
 */
export function parsePeopleFile(text: string): readonly PersonItem[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OpsError("invalid_file", "The change file is not JSON."); }
  const items = isRecord(value) ? value.items : undefined;
  if (!isRecord(value) || Object.keys(value).join() !== "items" || !Array.isArray(items) || items.length === 0) throw new OpsError("invalid_file", 'The change file must be {"items": [...]} with at least one item.');
  const seen = new Set<string>();
  return items.map((item, index) => {
    const where = `items[${index}]`;
    const keys = isRecord(item) ? Object.keys(item).sort().join() : "";
    if (!isRecord(item) || (keys !== "listing,providerId" && keys !== "listing,memberId,providerId") || typeof item.providerId !== "string" || !item.providerId || !isRecord(item.listing)) throw new OpsError("invalid_file", `${where} needs providerId, a listing object and, optionally, memberId.`);
    if (item.memberId !== undefined && item.memberId !== null && (typeof item.memberId !== "string" || !item.memberId)) throw new OpsError("invalid_file", `${where}.memberId must be a host account id or null.`);
    const extra = Object.keys(item.listing).filter((key) => !(FIELDS as readonly string[]).includes(key) && key !== "experiences" && key !== "photo");
    if (extra.length > 0 || typeof item.listing.slug !== "string" || item.listing.slug === "") throw new OpsError("invalid_file", `${where}.listing needs slug and takes ${[...FIELDS, "experiences", "photo"].join(", ")}.`);
    const experiences = item.listing.experiences;
    if (experiences !== undefined) {
      if (!Array.isArray(experiences) || experiences.length > EXPERIENCES_MAX) throw new OpsError("invalid_file", `${where}.listing.experiences must be a list of at most ${EXPERIENCES_MAX} products.`);
      for (const entry of experiences) {
        const slug = typeof entry === "string" && entry !== "";
        const ids = isRecord(entry) && Object.keys(entry).sort().join() === "productId,providerId" && typeof entry.providerId === "string" && typeof entry.productId === "string";
        if (!slug && !ids) throw new OpsError("invalid_file", `${where}.listing.experiences names a product by its slug, or by {"providerId", "productId"}.`);
      }
    }
    const photo = item.listing.photo;
    if (photo !== undefined && photo !== null && (!isRecord(photo) || typeof photo.assetId !== "string" || typeof photo.altJa !== "string")) throw new OpsError("invalid_file", `${where}.listing.photo is {"assetId", "altJa", "credit"} or null.`);
    if (seen.has(item.listing.slug)) throw new OpsError("invalid_file", `${where}: ${item.listing.slug} appears twice.`);
    seen.add(item.listing.slug);
    return { providerId: item.providerId, ...(item.memberId === undefined ? {} : { memberId: item.memberId as string | null }), listing: item.listing };
  });
}

/** The listing wanted: the current one (null when not listed yet) with the keys given replaced, normalised the way the server does. A new listing needs slug, nameJa, roleJa, areaJa and sortOrder. */
export function desiredListing(current: Readonly<Record<string, unknown>> | null, given: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged = { ...(current ?? { quoteJa: null, introJa: null }), ...given };
  if (!current) for (const field of ["slug", "nameJa", "roleJa", "areaJa", "sortOrder"]) if (merged[field] === undefined) throw new OpsError("invalid_listing", `A new listing needs ${field}.`);
  try {
    return { ...validatePeopleListingInput(merged as never) };
  } catch (error) {
    throw new OpsError("invalid_listing", error instanceof Error ? error.message : "The listing is invalid.");
  }
}

/**
 * The products a listing's `experiences` name: a slug resolves to its one product (more than one provider with that slug is
 * `slug_is_ambiguous_use_providerId_and_productId`), a `{providerId, productId}` must exist. Archived products are not offered.
 */
export function resolveExperiences(products: readonly (ExperienceRef & { readonly slug: string; readonly status?: string })[], entries: readonly unknown[]): ExperienceRef[] {
  const usable = products.filter((product) => product.status !== "ARCHIVED") as readonly ProductRef[];
  const seen = new Set<string>();
  return entries.map((entry) => {
    let match: ProductRef | undefined;
    if (typeof entry === "string") {
      const found = usable.filter((product) => product.slug === entry);
      if (found.length > 1) throw new OpsError("slug_is_ambiguous_use_providerId_and_productId", `The slug ${entry} is used by more than one provider; name it by providerId and productId.`);
      match = found[0];
      if (!match) throw new OpsError("unknown_experience", `No experience has the slug ${entry}.`);
    } else {
      const ref = entry as ExperienceRef;
      match = usable.find((product) => product.providerId === ref.providerId && product.productId === ref.productId);
      if (!match) throw new OpsError("unknown_experience", `No experience ${ref.providerId}/${ref.productId}.`);
    }
    const key = `${match.providerId}/${match.productId}`;
    if (seen.has(key)) throw new OpsError("invalid_listing", `${match.slug} appears twice in experiences.`);
    seen.add(key);
    return { providerId: match.providerId, productId: match.productId };
  });
}

async function listProductRefs(context: Context): Promise<readonly (ProductRef & { readonly status?: string })[]> {
  const response = await context.api.get(PRODUCTS_API);
  if (response.status !== 200) throw failureOf(response, "product list");
  const products = (response.body as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) throw new OpsError("unexpected_response", "The product list was not understood.");
  return products as (ProductRef & { readonly status?: string })[];
}

interface State { readonly listingId: string | null; readonly version: number | null; readonly listing: Record<string, unknown> }

/** The listing named by its slug: its id and version, and what it is now (the provider and member too, so a move shows in the differences). */
function stateOf(rows: readonly PersonRow[], slug: string): State {
  const row = rows.find((candidate) => candidate.listing !== null && candidate.listing.slug === slug);
  if (!row || !row.listing) return { listingId: null, version: null, listing: {} };
  return { listingId: row.listing.id ?? null, version: row.listing.version, listing: { providerId: row.providerId, memberId: row.memberId ?? null, ...fieldsOf(row.listing) } };
}

const failed = (key: string, error: unknown): WriteResult => ({ key, status: "failed", changes: [], error: error instanceof OpsError ? error.code : "failed" });

function finish(results: readonly WriteResult[], summaryOnly = false): unknown {
  const count = (status: string) => results.filter((result) => result.status === status).length;
  const summary = { total: results.length, unchanged: count("unchanged"), planned: count("dry_run"), applied: count("applied"), failed: count("failed") };
  if (summary.failed > 0) throw new OpsError(results.find((result) => result.status === "failed")?.error ?? "failed", "Some items failed; see items. Fix them (or read again if a person changed meanwhile) and run again: finished items are skipped.", results.some((result) => result.error === "conflict") ? EXIT.conflict : EXIT.failed, { summary, items: results });
  return summaryOnly ? { summary } : { summary, items: results };
}

const respondOk = (response: ApiResponse) => response;

const apply: Action = {
  tier: "publish",
  summary: "Lists people on 街の人, or changes their row (a person is a member of a provider; the listing is named by its slug; providerId, memberId: the member's host account id or null, and slug, nameJa, roleJa, areaJa, quoteJa, introJa, sortOrder, photo: {assetId, altJa, credit}, experiences: the products they are met through, by slug or {providerId, productId}, replaced as a whole when given). Only the keys given change. Without a member the listing is a draft, not shown; a person appears on the public site once their member is a current OWNER or co-host. Without --yes it prints the differences only.",
  async run(context) {
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <people.json> is required.", EXIT.usage);
    const text = context.readFile(file);
    const seed = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const results: WriteResult[] = [];
    const items = parsePeopleFile(text);
    // Products are read once, and only when a listing names experiences.
    const products = items.some((item) => item.listing.experiences !== undefined) ? await listProductRefs(context) : [];
    for (const item of items) {
      const slug = item.listing.slug as string;
      try {
        const given = item.listing.experiences === undefined ? item.listing : { ...item.listing, experiences: resolveExperiences(products, item.listing.experiences as unknown[]) };
        let state: State = { listingId: null, version: null, listing: {} };
        results.push(await writeOne<Record<string, unknown>>(context, [seed, "people-apply"], {
          key: slug,
          read: async () => { state = stateOf(await listPeople(context), slug); return state.listing; },
          desired: (current) => {
            const { providerId: _provider, memberId: _member, ...currentListing } = current;
            void _provider; void _member;
            const wanted = desiredListing(state.version === null ? null : currentListing, given);
            // The member: kept unless the file says it (a new listing has none, which makes it a draft).
            const memberId = item.memberId !== undefined ? item.memberId : (state.listing.memberId ?? null);
            return { providerId: item.providerId, memberId, ...wanted };
          },
          send: async (_current, desired, operationId) => {
            const { providerId, memberId, ...rest } = desired as Record<string, unknown>;
            // The links and the photo are sent only when the file says them: an edit of something else must not carry (and have the server re-check) what it did not touch.
            const { experiences: _kept, photo: _photo, ...base } = rest;
            void _kept; void _photo;
            const listing = {
              ...base,
              ...(item.listing.experiences === undefined ? {} : { experiences: rest.experiences }),
              ...(item.listing.photo === undefined ? {} : { photo: rest.photo ?? null }),
            };
            return respondOk(await context.api.send("PUT", API, { listingId: state.listingId, providerId, memberId, listing, expectedVersion: state.version }, operationId));
          },
        }));
      } catch (error) {
        if (error instanceof OpsError && error.exit !== EXIT.failed && error.code !== "invalid_listing" && error.code !== "unknown_experience" && error.code !== "slug_is_ambiguous_use_providerId_and_productId") throw error;
        results.push(failed(slug, error));
      }
    }
    return finish(results);
  },
};

const withdraw: Action = {
  tier: "publish",
  summary: "Takes a person off 街の人 (--slug <slug>). Messages already sent and the photo stay. Without --yes it prints the difference only.",
  async run(context) {
    const slug = context.args.flags.slug;
    if (typeof slug !== "string") throw new OpsError("usage", "--slug <slug> is required.", EXIT.usage);
    let state: State = { listingId: null, version: null, listing: {} };
    const result = await writeOne<Record<string, unknown>>(context, ["people-withdraw"], {
      key: slug,
      read: async () => {
        state = stateOf(await listPeople(context), slug);
        if (state.listingId === null) throw new OpsError("unknown_listing", `No listing has the slug ${slug}.`);
        return state.listing;
      },
      desired: () => ({}),
      send: async (_current, _desired, operationId) => respondOk(await context.api.send("DELETE", API, { listingId: state.listingId, expectedVersion: state.version }, operationId)),
    });
    return finish([result]);
  },
};

/** The reasons a listed person is not shown, in the words of the Admin screen. */
function hiddenBecause(row: PersonRow): readonly string[] {
  return [
    ...(row.memberRole === null ? [NO_MEMBER_REASON] : []),
    ...(row.photoReady === false ? ["公開してよい写真が無いため非公開"] : []),
  ];
}

const list: Action = {
  tier: "read",
  summary: "Lists the people on 街の人 and the OWNERs and co-hosts who are not listed yet, and whether each is shown (--listed, --unlisted; --provider <id>, --slug <slug> for one).",
  async run(context) {
    let rows = [...(await listPeople(context))];
    if (context.args.flags.listed === true) rows = rows.filter((row) => row.listing !== null);
    if (context.args.flags.unlisted === true) rows = rows.filter((row) => row.listing === null);
    const provider = context.args.flags.provider;
    if (typeof provider === "string") rows = rows.filter((row) => row.providerId === provider);
    const slug = context.args.flags.slug;
    if (typeof slug === "string") rows = rows.filter((row) => row.listing?.slug === slug);
    // Why a listed person is not on the public pages (#589): the Admin screen says the same.
    return { count: rows.length, people: rows.map((row) => (row.listing !== null && !row.visible ? { ...row, hiddenBecause: hiddenBecause(row) } : row)) };
  },
};

export const peopleTarget: Target = {
  summary: "街の人: the people the Japanese site shows on its people pages (日本語サイトの街の人; a person is a member of a provider)",
  actions: { list, apply, withdraw },
};
