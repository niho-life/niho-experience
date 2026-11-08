export const dynamic = "force-dynamic";

// Editor publications are retired. Keep the NIHO consumer response shape while no
// Experience-owned app opt-in source has been defined.
export function GET(request: Request): Response {
  void request; // Legacy cursor queries are accepted, but no publication source can supply cards.
  return Response.json({ version: 1, items: [], nextCursor: null }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } });
}
