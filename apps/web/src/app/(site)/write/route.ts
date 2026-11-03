import { config } from "@/lib/config";

const EXPERIENCE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function GET(request: Request): Response {
  if (!config.guideEditorSiteOrigin) return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  const value = new URL(request.url).searchParams.getAll("experience");
  if (value.length > 1 || (value[0] !== undefined && (value[0].length > 160 || !EXPERIENCE_SLUG.test(value[0])))) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const target = new URL("/p/new", config.guideEditorSiteOrigin);
  target.searchParams.set("destination", "exp");
  target.searchParams.set("lang", "en");
  if (value[0]) target.searchParams.set("experience", value[0]);
  return Response.redirect(target, 307);
}
