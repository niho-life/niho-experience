import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { productClassificationRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * 商品の分類 (#529), NIHO's office: every product's category, area, だれと and こんな日に, set one by one (代理登録) or many
 * together (既存の商品をまとめて入れる). A signed-in Admin only; a change also needs the same-origin check.
 */
const BODY_LIMIT = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

function failure(error: unknown): Response {
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  console.error("Product classification failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

async function boundary(request: Request, mutation: boolean) {
  if (!isAdminHttp()) return { ok: false as const, response: adminJson({ error: "not_found" }, 404) };
  if (mutation && !adminMutationAllowed(request)) return { ok: false as const, response: adminJson({ error: "forbidden" }, 403) };
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return { ok: false as const, response: adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401) };
  const repository = productClassificationRepository();
  if (!repository) return { ok: false as const, response: adminJson({ error: "unavailable" }, 503) };
  return { ok: true as const, actor: { nihoUserId: loaded.actor.id }, repository };
}

/** No query: every product. `providerId` and `productId`: that product's classification. */
export async function GET(request: Request): Promise<Response> {
  const current = await boundary(request, false); if (!current.ok) return current.response;
  const params = new URL(request.url).searchParams;
  try {
    if (params.size === 0) return adminJson({ products: await current.repository.adminList(current.actor) });
    const providerId = params.get("providerId"); const productId = params.get("productId");
    if (params.size !== 2 || !providerId || !productId || !ID.test(providerId) || !ID.test(productId)) return adminJson({ error: "invalid_input" }, 400);
    return adminJson({ classification: await current.repository.adminRead(current.actor, providerId, productId) });
  } catch (error) { return failure(error); }
}

/**
 * `{ items: [{ providerId, productId, classification, expected? }] }`: all or none. `expected` (運営の CLI, #576) is the value
 * the caller read: if the product's value is no longer that, nothing is saved (409 `conflict`).
 */
export async function PUT(request: Request): Promise<Response> {
  const current = await boundary(request, true); if (!current.ok) return current.response;
  if (new URL(request.url).search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return adminJson({ error: "invalid_input" }, 400);
  let body: Record<string, unknown>;
  try {
    const value = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("shape");
    body = value as Record<string, unknown>;
  } catch { return adminJson({ error: "invalid_input" }, 400); }
  const items = body.items;
  if (Object.keys(body).join() !== "items" || !Array.isArray(items)
    || items.some((item) => typeof item !== "object" || item === null || Array.isArray(item) || !["classification,productId,providerId", "classification,expected,productId,providerId"].includes(Object.keys(item).sort().join())
      || typeof item.providerId !== "string" || typeof item.productId !== "string")) return adminJson({ error: "invalid_input" }, 400);
  try { return adminJson({ saved: await current.repository.adminSave(current.actor, items as never) }); } catch (error) { return failure(error); }
}
