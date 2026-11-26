import { createHash } from "node:crypto";
import { validatePeopleListingInput, type AdminPeopleListingRow } from "@niho-experience/experience-store";
import { EXIT, OpsError, failureOf, writeOne, type Action, type ApiResponse, type Context, type Target, type WriteResult } from "./core.ts";

/*
 * 街の人 (#564, #589, docs/people.md) from the command line: the Admin screen's `/admin/api/people`. A listing is a person who
 * belongs to a provider (provider × member account); it is named in a change file by its slug. Listing a person (or changing,
 * moving or withdrawing the row) shows or hides them on the public site at once, so the changes are `publish`-tier. A change
 * carries the version this run read (`expectedVersion`): one that changed meanwhile, or a slug somebody else took, is
 * refused with 409 and nothing is overwritten.
 */

const API = "/admin/api/people";
const FIELDS = ["slug", "sortOrder"] as const;
const NO_MEMBER_REASON = "本人のアカウントが提供者の現役メンバーでないため非公開";
export type PersonRow = AdminPeopleListingRow;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function listPeople(context: Context): Promise<readonly PersonRow[]> {
  const response = await context.api.get(API);
  if (response.status !== 200) throw failureOf(response, "people list");
  const people = (response.body as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) throw new OpsError("unexpected_response", "The people list was not understood.");
  return people as PersonRow[];
}

const fieldsOf = (listing: NonNullable<PersonRow["listing"]>) => ({ slug: listing.slug, sortOrder: listing.sortOrder });

export interface PersonItem {
  readonly providerId: string;
  /** The member's host account id; left out keeps the current member, and null is permitted for a legacy unassigned listing. */
  readonly memberId?: string | null;
  readonly listing: Readonly<Record<string, unknown>>;
}

/** A listing is named by its slug and contains its sort order. */
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
    const extra = Object.keys(item.listing).filter((key) => !(FIELDS as readonly string[]).includes(key));
    if (extra.length > 0 || typeof item.listing.slug !== "string" || item.listing.slug === "") throw new OpsError("invalid_file", `${where}.listing takes only slug and sortOrder. Edit the member profile in the host account and select guides in the experience editor.`);
    if (seen.has(item.listing.slug)) throw new OpsError("invalid_file", `${where}: ${item.listing.slug} appears twice.`);
    seen.add(item.listing.slug);
    return { providerId: item.providerId, ...(item.memberId === undefined ? {} : { memberId: item.memberId as string | null }), listing: item.listing };
  });
}

export function desiredListing(current: Readonly<Record<string, unknown>> | null, given: Readonly<Record<string, unknown>>): Record<string, unknown> {
  try {
    return { ...validatePeopleListingInput({ ...current, ...given } as never) };
  } catch (error) {
    throw new OpsError("invalid_listing", error instanceof Error ? error.message : "The listing is invalid.");
  }
}

interface State { readonly listingId: string | null; readonly version: number | null; readonly listing: Record<string, unknown> }

/** Read the listing named by its slug and its version. */
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
  summary: "Sets the 街の人 listing slug and sortOrder for a provider member. Required for a new listing: providerId, memberId, slug and sortOrder. Without --yes it prints the differences only.",
  async run(context) {
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <people.json> is required.", EXIT.usage);
    const text = context.readFile(file);
    const seed = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const results: WriteResult[] = [];
    const items = parsePeopleFile(text);
    for (const item of items) {
      const slug = item.listing.slug as string;
      try {
        let state: State = { listingId: null, version: null, listing: {} };
        results.push(await writeOne<Record<string, unknown>>(context, [seed, "people-apply"], {
          key: slug,
          read: async () => { state = stateOf(await listPeople(context), slug); return state.listing; },
          desired: (current) => {
            const { providerId: _provider, memberId: _member, ...currentListing } = current;
            void _provider; void _member;
            const wanted = desiredListing(state.version === null ? null : currentListing, item.listing);
            const memberId = item.memberId !== undefined ? item.memberId : (state.listing.memberId ?? null);
            if (state.version === null && memberId === null) throw new OpsError("invalid_listing", "A memberId is required for a new listing.");
            if (state.version !== null && (item.providerId !== state.listing.providerId
              || (state.listing.memberId !== null && memberId !== state.listing.memberId))) {
              throw new OpsError("invalid_listing", "An existing listing's provider and assigned member cannot change.");
            }
            return { providerId: item.providerId, memberId, ...wanted };
          },
          send: async (_current, desired, operationId) => {
            const { providerId, memberId, ...listing } = desired as Record<string, unknown>;
            return respondOk(await context.api.send("PUT", API, { listingId: state.listingId, providerId, memberId, listing, expectedVersion: state.version }, operationId));
          },
        }));
      } catch (error) {
        if (error instanceof OpsError && error.exit !== EXIT.failed && error.code !== "invalid_listing") throw error;
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
  return [row.memberRole === null ? NO_MEMBER_REASON : "公開中の本人プロフィールまたは写真が無いため非公開"];
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
