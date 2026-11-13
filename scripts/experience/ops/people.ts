import { createHash } from "node:crypto";
import { validatePeopleListingInput } from "@niho-experience/experience-store";
import { EXIT, OpsError, failureOf, writeOne, type Action, type ApiResponse, type Context, type Target, type WriteResult } from "./core.ts";

/*
 * 街の人 (#564, docs/people.md) from the command line: the Admin screen's `/admin/api/people`. Listing a provider (or changing
 * or withdrawing their row) shows or hides a person on the public site at once, so the changes are `publish`-tier. A change
 * carries the version this run read (`expectedVersion`): one that changed meanwhile, or a slug somebody else took, is
 * refused with 409 and nothing is overwritten.
 */

const API = "/admin/api/people";
const FIELDS = ["slug", "roleJa", "areaJa", "quoteJa", "introJa", "sortOrder"] as const;

export interface PersonRow {
  readonly providerId: string;
  readonly publicDisplayName: string;
  readonly photoReady: boolean;
  readonly hasHostBio: boolean;
  readonly publicExperienceCount: number;
  readonly listing: (Record<(typeof FIELDS)[number], unknown> & { readonly version: number; readonly updatedAtUtc: string }) | null;
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

const fieldsOf = (listing: PersonRow["listing"]): Record<string, unknown> => listing ? Object.fromEntries(FIELDS.map((field) => [field, listing[field] ?? null])) : {};

export interface PersonItem {
  readonly providerId: string;
  readonly listing: Readonly<Record<string, unknown>>;
}

/** `{ "items": [{ "providerId": "...", "listing": { "slug": "...", "roleJa": "...", "areaJa": "...", "sortOrder": 10 } }] }` */
export function parsePeopleFile(text: string): readonly PersonItem[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OpsError("invalid_file", "The change file is not JSON."); }
  const items = isRecord(value) ? value.items : undefined;
  if (!isRecord(value) || Object.keys(value).join() !== "items" || !Array.isArray(items) || items.length === 0) throw new OpsError("invalid_file", 'The change file must be {"items": [...]} with at least one item.');
  const seen = new Set<string>();
  return items.map((item, index) => {
    const where = `items[${index}]`;
    if (!isRecord(item) || Object.keys(item).sort().join() !== "listing,providerId" || typeof item.providerId !== "string" || !item.providerId || !isRecord(item.listing)) throw new OpsError("invalid_file", `${where} needs providerId and a listing object.`);
    const extra = Object.keys(item.listing).filter((key) => !(FIELDS as readonly string[]).includes(key));
    if (extra.length > 0 || Object.keys(item.listing).length === 0) throw new OpsError("invalid_file", `${where}.listing takes ${FIELDS.join(", ")} (at least one).`);
    if (seen.has(item.providerId)) throw new OpsError("invalid_file", `${where}: ${item.providerId} appears twice.`);
    seen.add(item.providerId);
    return { providerId: item.providerId, listing: item.listing };
  });
}

/** The listing wanted: the current one (null when not listed yet) with the keys given replaced, normalised the way the server does. A new listing needs slug, roleJa, areaJa and sortOrder. */
export function desiredListing(current: Readonly<Record<string, unknown>> | null, given: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged = { ...(current ?? { quoteJa: null, introJa: null }), ...given };
  if (!current) for (const field of ["slug", "roleJa", "areaJa", "sortOrder"]) if (merged[field] === undefined) throw new OpsError("invalid_listing", `A new listing needs ${field}.`);
  try {
    return { ...validatePeopleListingInput(merged as never) };
  } catch (error) {
    throw new OpsError("invalid_listing", error instanceof Error ? error.message : "The listing is invalid.");
  }
}

interface State { readonly version: number | null; readonly listing: Record<string, unknown> }

function stateOf(rows: readonly PersonRow[], providerId: string): State {
  const row = rows.find((candidate) => candidate.providerId === providerId);
  if (!row) throw new OpsError("provider_has_no_public_profile", `${providerId} has no public profile, so it cannot be listed.`);
  return { version: row.listing?.version ?? null, listing: fieldsOf(row.listing) };
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
  summary: "Lists providers on 街の人, or changes their row (slug, roleJa, areaJa, quoteJa, introJa, sortOrder). Only the keys given change. A person appears on the public site at once. Without --yes it prints the differences only.",
  async run(context) {
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <people.json> is required.", EXIT.usage);
    const text = context.readFile(file);
    const seed = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const results: WriteResult[] = [];
    for (const item of parsePeopleFile(text)) {
      try {
        let version: number | null = null;
        results.push(await writeOne<Record<string, unknown>>(context, [seed, "people-apply"], {
          key: item.providerId,
          read: async () => { const state = stateOf(await listPeople(context), item.providerId); version = state.version; return state.listing; },
          desired: (current) => desiredListing(version === null ? null : current, item.listing),
          send: async (_current, desired, operationId) => respondOk(await context.api.send("PUT", API, { providerId: item.providerId, listing: desired, expectedVersion: version }, operationId)),
        }));
      } catch (error) {
        if (error instanceof OpsError && error.exit !== EXIT.failed && error.code !== "invalid_listing" && error.code !== "provider_has_no_public_profile") throw error;
        results.push(failed(item.providerId, error));
      }
    }
    return finish(results);
  },
};

const withdraw: Action = {
  tier: "publish",
  summary: "Takes a provider off 街の人 (--provider <providerId>). The public profile and photo stay. Without --yes it prints the difference only.",
  async run(context) {
    const providerId = context.args.flags.provider;
    if (typeof providerId !== "string") throw new OpsError("usage", "--provider <providerId> is required.", EXIT.usage);
    let version: number | null = null;
    const result = await writeOne<Record<string, unknown>>(context, ["people-withdraw"], {
      key: providerId,
      read: async () => { const state = stateOf(await listPeople(context), providerId); version = state.version; return state.listing; },
      desired: () => ({}),
      send: async (_current, _desired, operationId) => respondOk(await context.api.send("DELETE", API, { providerId, expectedVersion: version }, operationId)),
    });
    return finish([result]);
  },
};

const list: Action = {
  tier: "read",
  summary: "Lists the providers with a public profile and whether each is on 街の人 (--listed, --unlisted; --provider <id> for one).",
  async run(context) {
    let rows = [...(await listPeople(context))];
    if (context.args.flags.listed === true) rows = rows.filter((row) => row.listing !== null);
    if (context.args.flags.unlisted === true) rows = rows.filter((row) => row.listing === null);
    const provider = context.args.flags.provider;
    if (typeof provider === "string") rows = rows.filter((row) => row.providerId === provider);
    return { count: rows.length, people: rows };
  },
};

export const peopleTarget: Target = {
  summary: "街の人: who the Japanese site shows on its people pages (日本語サイトの街の人)",
  actions: { list, apply, withdraw },
};
