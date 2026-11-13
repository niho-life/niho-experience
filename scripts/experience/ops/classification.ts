import { createHash } from "node:crypto";
import { EXPERIENCE_AREAS, EXPERIENCE_CATEGORIES, EXPERIENCE_COMPANIONS, EXPERIENCE_OCCASIONS, parseExperienceClassification } from "@niho-experience/experience-domain";
import { EXIT, OpsError, diffValues, failureOf, operationId, type Action, type ApiResponse, type Change, type Context, type Target } from "./core.ts";

/*
 * 商品の分類 (#529, docs/product-classification.md) from the command line: the Admin screens' `/admin/api/product-classifications`.
 * A file names products by slug (or by providerId and productId) and says what the classification should be; only the keys it
 * mentions change. Each change carries the value this run read (`expected`), so one that somebody changed meanwhile is refused.
 */

const API = "/admin/api/product-classifications";
/** Products per request (the request is all or none; the server takes 300). */
export const CLASSIFICATION_CHUNK = 50;

export interface Classification {
  readonly category: string | null;
  readonly area: string | null;
  readonly companions: readonly string[];
  readonly occasions: readonly string[];
}

export interface ProductRow {
  readonly providerId: string;
  readonly productId: string;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly classification: Classification;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const PART_KEYS = ["category", "area", "companions", "occasions"] as const;

async function listProducts(context: Context): Promise<readonly ProductRow[]> {
  const response = await context.api.get(API);
  if (response.status !== 200) throw failureOf(response, "classification list");
  const products = (response.body as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) throw new OpsError("unexpected_response", "The product list was not understood.");
  return products as ProductRow[];
}

export interface ChangeItem {
  readonly slug?: string;
  readonly providerId?: string;
  readonly productId?: string;
  readonly classification: Readonly<Record<string, unknown>>;
}

/** The change file: `{ "items": [{ "slug": "...", "classification": { "category": "walk", ... } }] }` (only the keys given change). */
export function parseChangeFile(text: string): readonly ChangeItem[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OpsError("invalid_file", "The change file is not JSON."); }
  const items = isRecord(value) ? value.items : undefined;
  if (!isRecord(value) || Object.keys(value).join() !== "items" || !Array.isArray(items) || items.length === 0) throw new OpsError("invalid_file", 'The change file must be {"items": [...]} with at least one item.');
  return items.map((item, index) => {
    const where = `items[${index}]`;
    if (!isRecord(item) || !isRecord(item.classification)) throw new OpsError("invalid_file", `${where} needs a classification object.`);
    const unknown = Object.keys(item).filter((key) => !["slug", "providerId", "productId", "classification"].includes(key));
    if (unknown.length > 0) throw new OpsError("invalid_file", `${where} has an unknown key: ${unknown[0]}.`);
    const hasSlug = typeof item.slug === "string" && item.slug !== "";
    const hasIds = typeof item.providerId === "string" && typeof item.productId === "string";
    if (hasSlug === hasIds) throw new OpsError("invalid_file", `${where} names the product by slug, or by providerId and productId (not both, not neither).`);
    const partial = item.classification;
    const extra = Object.keys(partial).filter((key) => !(PART_KEYS as readonly string[]).includes(key));
    if (extra.length > 0 || Object.keys(partial).length === 0) throw new OpsError("invalid_file", `${where}.classification takes ${PART_KEYS.join(", ")} (at least one).`);
    return { slug: hasSlug ? item.slug as string : undefined, providerId: hasIds ? item.providerId as string : undefined, productId: hasIds ? item.productId as string : undefined, classification: partial };
  });
}

export interface Planned {
  readonly key: string;
  readonly row: ProductRow | null;
  readonly desired: Classification | null;
  readonly changes: readonly Change[];
  readonly error?: string;
}

/** Resolves each item to a product and the value wanted (the current one with the given keys replaced), and what differs. */
export function planChanges(items: readonly ChangeItem[], products: readonly ProductRow[]): Planned[] {
  const seen = new Set<string>();
  return items.map((item) => {
    const key = item.slug ?? `${item.providerId}/${item.productId}`;
    const matches = item.slug !== undefined ? products.filter((row) => row.slug === item.slug) : products.filter((row) => row.providerId === item.providerId && row.productId === item.productId);
    if (matches.length === 0) return { key, row: null, desired: null, changes: [], error: "product_not_found" };
    if (matches.length > 1) return { key, row: null, desired: null, changes: [], error: "slug_is_ambiguous_use_providerId_and_productId" };
    const row = matches[0]!;
    const id = `${row.providerId}/${row.productId}`;
    if (seen.has(id)) return { key, row, desired: null, changes: [], error: "product_appears_twice" };
    seen.add(id);
    const parsed = parseExperienceClassification({ ...row.classification, ...item.classification });
    if (!parsed) return { key, row, desired: null, changes: [], error: "invalid_classification" };
    return { key, row, desired: parsed, changes: diffValues(row.classification, parsed) };
  });
}

type ItemStatus = "unchanged" | "dry_run" | "applied" | "failed" | "not_attempted";
interface ItemResult { readonly key: string; readonly status: ItemStatus; readonly changes?: readonly Change[]; readonly error?: string }

const chunksOf = <T,>(list: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function sendChunk(context: Context, seed: string, chunk: readonly Planned[], attempt: number): Promise<ApiResponse> {
  const body = { items: chunk.map((item) => ({ providerId: item.row!.providerId, productId: item.row!.productId, classification: item.desired, expected: item.row!.classification })) };
  return context.api.send("PUT", API, body, operationId([seed, ...chunk.map((item) => item.key)], attempt, context.now()));
}

const apply: Action = {
  tier: "edit",
  summary: "Sets the classification (category, area, companions, occasions) of the products a JSON file names. Only the keys given change; without --yes it prints the differences only.",
  async run(context) {
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <changes.json> is required.", EXIT.usage);
    const text = context.readFile(file);
    const seed = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const items = parseChangeFile(text);
    let plan = planChanges(items, await listProducts(context));
    const results: ItemResult[] = [];
    const pending: Planned[] = [];
    for (const item of plan) {
      if (item.error) results.push({ key: item.key, status: "failed", error: item.error });
      else if (item.changes.length === 0) results.push({ key: item.key, status: "unchanged" });
      else if (!context.apply) results.push({ key: item.key, status: "dry_run", changes: item.changes });
      else pending.push(item);
    }
    let stopped = false;
    if (context.apply) {
      // An invalid item stops the run before anything is sent, so a file is applied whole or not at all up to the chunk.
      if (results.some((result) => result.status === "failed")) {
        for (const item of pending) results.push({ key: item.key, status: "not_attempted" });
        stopped = true;
      } else {
        for (const chunk of chunksOf(pending, CLASSIFICATION_CHUNK)) {
          if (stopped) { for (const item of chunk) results.push({ key: item.key, status: "not_attempted" }); continue; }
          let current = chunk;
          let done = false;
          for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
            const response = await sendChunk(context, seed, current, attempt);
            if (response.status === 200) { for (const item of current) results.push({ key: item.key, status: "applied", changes: item.changes }); done = true; continue; }
            const error = failureOf(response, "classification apply");
            if (error.code === "operation_already_recorded") {
              // The server saw this operation before: read again; what is already in place is done, the rest is retried under a new ID.
              plan = planChanges(items, await listProducts(context));
              const byKey = new Map(plan.map((item) => [item.key, item]));
              const again = current.map((item) => byKey.get(item.key)!).filter((item) => !item.error && item.changes.length > 0);
              for (const item of current) if (!again.some((candidate) => candidate.key === item.key)) results.push({ key: item.key, status: "unchanged" });
              if (again.length === 0) { done = true; continue; }
              current = again;
              continue;
            }
            for (const item of current) results.push({ key: item.key, status: "failed", changes: item.changes, error: error.code });
            stopped = true;
            done = true;
          }
          if (!done) { for (const item of current) results.push({ key: item.key, status: "failed", error: "operation_already_recorded" }); stopped = true; }
        }
      }
    }
    const count = (status: ItemStatus) => results.filter((result) => result.status === status).length;
    const summary = { total: items.length, unchanged: count("unchanged"), planned: count("dry_run"), applied: count("applied"), failed: count("failed"), notAttempted: count("not_attempted"), stopped };
    if (summary.failed > 0) throw new OpsError(results.find((r) => r.status === "failed")?.error ?? "failed", "Some items failed; see items. Fix the file (or read again if it changed meanwhile) and run it again: finished items are skipped.", results.some((r) => r.error === "conflict") ? EXIT.conflict : EXIT.failed, { summary, items: results });
    return { summary, items: results };
  },
};

const list: Action = {
  tier: "read",
  summary: "Lists products with their classification (--slug <slug> for one, --status DRAFT|PUBLISHED, --unclassified for the ones without a category).",
  async run(context) {
    let rows = [...(await listProducts(context))];
    const slug = context.args.flags.slug;
    if (typeof slug === "string") rows = rows.filter((row) => row.slug === slug);
    const status = context.args.flags.status;
    if (typeof status === "string") rows = rows.filter((row) => row.status === status);
    if (context.args.flags.unclassified === true) rows = rows.filter((row) => row.classification.category === null);
    return { count: rows.length, products: rows };
  },
};

const options: Action = {
  tier: "read",
  summary: "The values a classification may take (the lists the site defines).",
  async run() {
    const pick = (list: readonly { id: string; label: string }[]) => list.map((item) => ({ id: item.id, label: item.label }));
    return { category: pick(EXPERIENCE_CATEGORIES), area: pick(EXPERIENCE_AREAS), companions: pick(EXPERIENCE_COMPANIONS), occasions: pick(EXPERIENCE_OCCASIONS) };
  },
};

export const classificationTarget: Target = {
  summary: "Product classification: category, area, with whom, what kind of day (日本語サイトの分類)",
  actions: { list, options, apply },
};
