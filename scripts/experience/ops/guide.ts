import { createHash } from "node:crypto";
import { EXIT, OpsError, failureOf, operationId, sendOnce, writeOne, type Action, type ApiResponse, type Context, type Target } from "./core.ts";
import { stableCommandId } from "./product.ts";

/*
 * 記事（読みもの）(#576 ⑤, docs/guide-cms.md) written by the office, from the command line: the routes the writers use
 * (`/write/api/guides`), through the Admin's Google ID token. The article belongs to a provider (--provider); by the owner's
 * decision (2026-11-14) the byline is the office's, "NIHO kamakura", unless the file names another author. Photos are only ever
 * ones whose rights a person has already cleared, so uploading one also confirms it for the web. Every change carries the
 * revision it read: one that somebody changed meanwhile is refused (409) and nothing is overwritten.
 */

const ROOT = "/write/api/guides";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const OFFICE_AUTHOR = Object.freeze({
  name: "NIHO kamakura",
  role: "街のリビング NIHO kamakura",
  // 仮の紹介文（オーナー決定 2026-11-14「事務局名義は NIHO kamakura でよい。一旦」）。ファイルの content.author で差し替えられる。
  bio: "鎌倉の街の人と、その人の時間を予約できる窓口を運営しています。",
});
export const OFFICE_CREDIT = "NIHO kamakura";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const enc = encodeURIComponent;

export interface GuideDto {
  readonly id: string;
  readonly slug: string;
  readonly subject: { readonly kind: string; readonly providerId?: string };
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: Record<string, unknown>;
  readonly cover?: Record<string, unknown>;
  readonly status: string;
  readonly revision: number;
  readonly currentPublication?: unknown;
}

function need(context: Context, flag: string): string {
  const value = context.args.flags[flag];
  if (typeof value !== "string" || !ID.test(value)) throw new OpsError("usage", `--${flag} <id> is required.`, EXIT.usage);
  return value;
}

function body(response: ApiResponse, action: string): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) throw failureOf(response, action);
  return isRecord(response.body) ? response.body : {};
}

async function readGuide(context: Context, id: string): Promise<GuideDto> {
  const found = body(await context.api.get(`${ROOT}/${enc(id)}`), "guide show").guide;
  if (!isRecord(found)) throw new OpsError("unexpected_response", "The article was not understood.");
  return found as unknown as GuideDto;
}

const summary = (guide: GuideDto) => ({
  id: guide.id, slug: guide.slug, title: guide.title, status: guide.status, revision: guide.revision,
  providerId: guide.subject.providerId ?? null, categorySlug: guide.categorySlug ?? null, language: guide.content.language ?? null,
  hasCover: guide.cover !== undefined, publication: guide.currentPublication ?? null,
});

function readJsonFile(context: Context): Record<string, unknown> {
  const file = context.args.flags.file;
  if (typeof file !== "string") throw new OpsError("usage", "--file <article.json> is required.", EXIT.usage);
  let value: unknown;
  try { value = JSON.parse(context.readFile(file)); } catch { throw new OpsError("invalid_file", "The file is not JSON."); }
  if (!isRecord(value)) throw new OpsError("invalid_file", "The file must be an object.");
  return value;
}

const categories: Action = {
  tier: "read",
  summary: "The article categories that can be chosen (slug, English and Japanese label).",
  async run(context) {
    return body(await context.api.get("/write/api/categories"), "guide categories");
  },
};

const list: Action = {
  tier: "read",
  summary: "Lists the articles (id, slug, title, status, revision, provider, language, cover).",
  async run(context) {
    const guides = body(await context.api.get(ROOT), "guide list").guides;
    const rows = (Array.isArray(guides) ? (guides as GuideDto[]) : []).map(summary);
    return { count: rows.length, guides: rows };
  },
};

const show: Action = {
  tier: "read",
  summary: "One article in full: draft body (Markdown), author, cover, status and the revision a change must carry (--id).",
  async run(context) {
    return { guide: await readGuide(context, need(context, "id")) };
  },
};

const create: Action = {
  tier: "edit",
  summary: 'Creates an article draft for a provider (--provider, --file {"slug","title","description"?,"categorySlug"?,"content":{"markdown","language"?:"ja","author"?}}). The byline is "NIHO kamakura" unless content.author says otherwise. The same slug for the provider is not created twice.',
  async run(context) {
    const providerId = need(context, "provider");
    const file = readJsonFile(context);
    const extra = Object.keys(file).filter((key) => !["slug", "title", "description", "categorySlug", "content"].includes(key));
    if (extra.length > 0) throw new OpsError("invalid_file", `Unknown key: ${extra[0]}.`);
    for (const key of ["slug", "title", "content"]) if (file[key] === undefined) throw new OpsError("invalid_file", `${key} is required.`);
    if (!isRecord(file.content) || typeof file.content.markdown !== "string") throw new OpsError("invalid_file", "content.markdown is required.");
    const id = stableCommandId("guide", providerId, String(file.slug));
    const content: Record<string, unknown> = { language: "ja", author: OFFICE_AUTHOR, ...file.content };
    const payload = { id, providerId, slug: file.slug, title: file.title, description: file.description ?? "", ...(file.categorySlug === undefined ? {} : { categorySlug: file.categorySlug }), content };
    if (!context.apply) return { status: "dry_run", create: { ...payload, content: { ...content, markdown: `(${String(content.markdown).length} characters)` } } };
    const sent = await sendOnce(context, ["guide-create", id], (op) => context.api.send("POST", ROOT, payload, op), async () => {
      const found = await context.api.get(`${ROOT}/${enc(id)}`);
      return found.status === 200 && isRecord(found.body) && isRecord(found.body.guide) ? (found.body.guide as unknown as GuideDto) : null;
    });
    if ("done" in sent) return { status: "unchanged", guide: summary(sent.done) };
    const created = body(sent.response, "guide create");
    return { status: created.created === false ? "unchanged" : "applied", guide: isRecord(created.guide) ? summary(created.guide as unknown as GuideDto) : null };
  },
};

interface DraftState {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categorySlug: string | null;
  readonly content: Record<string, unknown>;
  readonly cover: Record<string, unknown> | null;
}

function draftOf(guide: GuideDto): DraftState {
  return { slug: guide.slug, title: guide.title, description: guide.description, categorySlug: guide.categorySlug ?? null, content: guide.content, cover: guide.cover ?? null };
}

async function saveDraft(context: Context, id: string, seed: readonly string[], change: (current: DraftState) => DraftState) {
  let guide: GuideDto | null = null;
  return writeOne<DraftState>(context, seed, {
    key: id,
    read: async () => { guide = await readGuide(context, id); return draftOf(guide); },
    desired: change,
    send: async (current, desired, operation) => context.api.send("PATCH", `${ROOT}/${enc(id)}`, {
      expectedRevision: guide!.revision, slug: desired.slug, title: desired.title, description: desired.description,
      ...(desired.categorySlug === null ? {} : { categorySlug: desired.categorySlug }), content: desired.content,
      ...(JSON.stringify(desired.cover) === JSON.stringify(current.cover) ? {} : { cover: desired.cover }),
    }, operation),
  });
}

const draft: Action = {
  tier: "edit",
  summary: 'Changes an article draft (--id, --file {"slug"?,"title"?,"description"?,"categorySlug"?,"content"?:{"markdown"?,"language"?,"author"?,"checkedOn"?}}). Only what is given changes; `content` is merged by key.',
  async run(context) {
    const id = need(context, "id");
    const given = readJsonFile(context);
    const extra = Object.keys(given).filter((key) => !["slug", "title", "description", "categorySlug", "content"].includes(key));
    if (extra.length > 0 || Object.keys(given).length === 0) throw new OpsError("invalid_file", "The file takes slug, title, description, categorySlug and/or content.");
    if (given.content !== undefined && !isRecord(given.content)) throw new OpsError("invalid_file", "content must be an object.");
    const seed = createHash("sha256").update(JSON.stringify(given)).digest("hex").slice(0, 16);
    const result = await saveDraft(context, id, ["guide-draft", id, seed], (current) => ({
      slug: (given.slug as string | undefined) ?? current.slug,
      title: (given.title as string | undefined) ?? current.title,
      description: (given.description as string | undefined) ?? current.description,
      categorySlug: (given.categorySlug as string | undefined) ?? current.categorySlug,
      content: { ...current.content, ...(given.content as Record<string, unknown> | undefined) },
      cover: current.cover,
    }));
    if (result.status === "failed") throw new OpsError(result.error ?? "failed", "The draft was not changed.", result.error === "conflict" ? EXIT.conflict : EXIT.failed, { result });
    return result;
  },
};

const IMAGE_TYPES: Readonly<Record<string, string>> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

const photoAdd: Action = {
  tier: "edit",
  summary: "Uploads a photo for the article (--id, --file image.jpg|png, --alt <alt text>, --credit <public credit, default NIHO kamakura>, --cover to set it as the cover). Only photos whose rights are already cleared: the upload also confirms it for the web. The result gives the asset id to use in the Markdown.",
  async run(context) {
    const id = need(context, "id");
    const file = context.args.flags.file;
    if (typeof file !== "string") throw new OpsError("usage", "--file <image.jpg|png> is required.", EXIT.usage);
    const type = IMAGE_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()];
    if (!type) throw new OpsError("usage", "The photo must be .jpg, .jpeg or .png.", EXIT.usage);
    const alt = context.args.flags.alt;
    if (typeof alt !== "string" || alt.trim() === "") throw new OpsError("usage", "--alt <alt text> is required.", EXIT.usage);
    const credit = typeof context.args.flags.credit === "string" ? context.args.flags.credit : OFFICE_CREDIT;
    const bytes = context.readBytes(file);
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new OpsError("invalid_file", "The photo must be 1 byte to 10 MB.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const cover = context.args.flags.cover === true;
    if (!context.apply) return { status: "dry_run", photo: { bytes: bytes.byteLength, contentType: type, alt, credit, cover }, sha256 };
    const seed = ["guide-photo", id, sha256, ...(context.args.flags.again === true ? [String(context.now())] : [])];
    const uploaded = await context.api.send("POST", `${ROOT}/${enc(id)}/media`, undefined, operationId(seed, 1, context.now()), { bytes, contentType: type, headers: {} });
    if (uploaded.status === 409 && (uploaded.body as { error?: unknown } | null)?.error === "operation_already_recorded") return { status: "unchanged", sha256, note: "This photo was already sent for this article; `guide show` lists what is attached. Use --again to upload it once more." };
    const asset = body(uploaded, "guide photo-add").asset;
    if (!isRecord(asset) || typeof asset.id !== "string") throw new OpsError("unexpected_response", "The asset was not understood.");
    const assetId = asset.id;
    const confirmed = await context.api.send("PUT", `${ROOT}/${enc(id)}/media/${enc(assetId)}`, { publicCredit: credit, webConfirmed: true }, operationId([...seed, "confirm", assetId], 1, context.now()));
    body(confirmed, "guide photo-add (web confirmation)");
    if (cover) {
      const result = await saveDraft(context, id, ["guide-cover", id, assetId], (current) => ({ ...current, cover: { assetId, alt, credit, webConfirmed: true } }));
      if (result.status === "failed") throw new OpsError(result.error ?? "failed", "The photo was uploaded but could not be set as the cover; run `guide draft` or read the article.", EXIT.failed, { assetId, result });
    }
    return { status: "applied", assetId, sha256, cover };
  },
};

const VISIBILITY = ["PUBLIC", "UNLISTED"] as const;

const publish: Action = {
  tier: "publish",
  summary: "Publishes the draft as it is (--id, --visibility PUBLIC|UNLISTED, default PUBLIC). The server checks the title, headings, category, language and photo confirmations and refuses otherwise. Without --yes it shows what would be published.",
  async run(context) {
    const id = need(context, "id");
    const visibility = typeof context.args.flags.visibility === "string" ? context.args.flags.visibility : "PUBLIC";
    if (!(VISIBILITY as readonly string[]).includes(visibility)) throw new OpsError("usage", "--visibility must be PUBLIC or UNLISTED.", EXIT.usage);
    const guide = await readGuide(context, id);
    if (!context.apply) return { status: "dry_run", wouldPublish: { ...summary(guide), visibility } };
    const sent = await sendOnce(context, ["guide-publish", id, String(guide.revision), visibility], (op) => context.api.send("POST", `${ROOT}/${enc(id)}/publication`, { expectedRevision: guide.revision, visibility }, op), async () => {
      const after = await readGuide(context, id);
      return after.revision !== guide.revision || after.status !== guide.status ? summary(after) : null;
    });
    if ("done" in sent) return { status: "unchanged", note: "The article changed after this publish was sent; its state is below.", guide: sent.done };
    const published = body(sent.response, "guide publish");
    return { status: "applied", publication: published.publication ?? null };
  },
};

const stop: Action = {
  tier: "publish",
  summary: "Stops a published article (--id). Without --yes it shows what would be stopped.",
  async run(context) {
    const id = need(context, "id");
    const guide = await readGuide(context, id);
    if (guide.status !== "PUBLISHED") return { status: "unchanged", note: "The article is not published.", guide: summary(guide) };
    if (!context.apply) return { status: "dry_run", wouldStop: summary(guide) };
    const sent = await sendOnce(context, ["guide-stop", id, String(guide.revision)], (op) => context.api.send("DELETE", `${ROOT}/${enc(id)}/publication`, { expectedRevision: guide.revision }, op), async () => {
      const after = await readGuide(context, id);
      return after.status !== "PUBLISHED" ? summary(after) : null;
    });
    if ("done" in sent) return { status: "unchanged", guide: sent.done };
    return { status: "applied", publication: body(sent.response, "guide stop").publication ?? null };
  },
};

export const guideTarget: Target = {
  summary: "Articles (読みもの): drafts written by the office as NIHO kamakura, photos, publishing and stopping",
  actions: { categories, list, show, create, draft, "photo-add": photoAdd, publish, stop },
};
