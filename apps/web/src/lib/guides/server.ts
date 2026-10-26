import "server-only";
import path from "node:path";
import { cache } from "react";
import { config } from "../config";
import { loadGuides } from "./load";

/**
 * `apps/web/content/guides`. The dev server and the standalone server both run from the app folder
 * (standalone: `.next/standalone/apps/web`, where next.config.ts traces the folder in).
 */
export const PUBLISHED_GUIDES_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "content", "guides");

/** One read per request: drafts (mock preview only) are re-read on the next request. */
export const getGuides = cache(() => loadGuides({ publishedDir: PUBLISHED_GUIDES_DIR, draftsDir: config.guideDraftsDir }));
