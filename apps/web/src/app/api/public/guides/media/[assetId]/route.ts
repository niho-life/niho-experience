export function GET() {
  return Response.json(
    { error: "not_found" },
    { status: 404, headers: { "cache-control": "public, max-age=0, no-store", "x-robots-tag": "noindex" } },
  );
}
