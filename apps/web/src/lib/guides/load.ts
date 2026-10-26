import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { compareGuides, parseGuide } from "./guide";
import type { Guide, GuideCollection, GuideProblem } from "./types";

type DirectoryResult = { guides: Guide[]; problems: GuideProblem[] };

const isManuscript = (name: string) => name.endsWith(".md") && !name.startsWith(".");

/**
 * Reads every `<slug>.md` in a folder. A published file that is not valid throws, so the unit test and
 * the build stop it; a draft that is not valid is skipped and reported, so its author can fix it.
 */
export async function readGuideDirectory(dir: string, draft: boolean): Promise<DirectoryResult> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter(isManuscript).sort();
  } catch (error) {
    if (!draft) throw new Error(`Published guides folder ${dir} could not be read`, { cause: error });
    return { guides: [], problems: [{ file: "GUIDE_DRAFTS_DIR", reasons: ["the drafts folder could not be read"] }] };
  }
  const guides: Guide[] = [];
  const problems: GuideProblem[] = [];
  for (const name of names) {
    let source: string;
    try {
      source = await readFile(path.join(dir, name), "utf8");
    } catch (error) {
      if (!draft) throw new Error(`Published guide ${name} could not be read`, { cause: error });
      problems.push({ file: name, reasons: ["the file could not be read"] });
      continue;
    }
    const result = parseGuide(name, source, { draft });
    if (result.ok) guides.push(result.guide);
    else if (draft) problems.push({ file: name, reasons: result.reasons });
    else throw new Error(`Published guide ${name} is not valid: ${result.reasons.join("; ")}`);
  }
  return { guides, problems };
}

let publishedCache: { dir: string; result: Promise<DirectoryResult> } | null = null;

/** Published guides change only with a deploy, so production reads them once. Development re-reads them. */
function readPublished(dir: string): Promise<DirectoryResult> {
  if (process.env.NODE_ENV !== "production") return readGuideDirectory(dir, false);
  if (publishedCache?.dir !== dir) publishedCache = { dir, result: readGuideDirectory(dir, false) };
  return publishedCache.result;
}

/**
 * Published guides, plus (mock preview only: `draftsDir` is null otherwise) the drafts, re-read on every
 * request so an author can save and reload. A draft replaces the published guide with the same slug.
 */
export async function loadGuides({ publishedDir, draftsDir }: { publishedDir: string; draftsDir: string | null }): Promise<GuideCollection> {
  const [published, drafts] = await Promise.all([readPublished(publishedDir), draftsDir ? readGuideDirectory(draftsDir, true) : null]);
  const bySlug = new Map(published.guides.map((guide) => [guide.slug, guide]));
  for (const guide of drafts?.guides ?? []) bySlug.set(guide.slug, guide);
  return { guides: [...bySlug.values()].sort(compareGuides), draftProblems: drafts?.problems ?? [] };
}
