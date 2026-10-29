import type { InventoryAdminSnapshot, InventoryResourceInput, ProductInventorySettingInput } from "@niho-experience/experience-store";
import { adminMutationAllowed, loadAdminHttpSession } from "@/lib/admin/server";
import { boundedObject, channelFailure, channelJson, channelManagerEnabled, exactKeys } from "@/lib/experience/channel-runtime";
import { experienceStore } from "@/lib/experience/store-server";

export const runtime = "nodejs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_KINDS = ["VENUE", "INSTRUCTOR", "EQUIPMENT"] as const;
const BOOKING_MODES = ["SEAT", "PRIVATE_GROUP"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function identifier(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function expectedVersion(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) > 0);
}

function resourceInput(value: unknown): InventoryResourceInput | null {
  const item = record(value);
  if (!item || !exactKeys(item, ["id", "kind", "displayName", "active"])) return null;
  if (!identifier(item.id) || typeof item.kind !== "string" || !(RESOURCE_KINDS as readonly string[]).includes(item.kind)
    || !identifier(item.displayName, 200) || typeof item.active !== "boolean") return null;
  return item as unknown as InventoryResourceInput;
}

function inventoryInput(value: unknown): ProductInventorySettingInput | null {
  const item = record(value);
  if (!item || !exactKeys(item, ["bookingMode", "resources"]) || typeof item.bookingMode !== "string"
    || !(BOOKING_MODES as readonly string[]).includes(item.bookingMode) || !Array.isArray(item.resources) || item.resources.length > 200) return null;
  const resources = [];
  const seen = new Set<string>();
  for (const raw of item.resources) {
    const assignment = record(raw);
    if (!assignment || !exactKeys(assignment, ["resourceId", "prepareMinutes", "cleanupMinutes"])
      || !identifier(assignment.resourceId) || seen.has(assignment.resourceId)
      || !Number.isInteger(assignment.prepareMinutes) || (assignment.prepareMinutes as number) < 0 || (assignment.prepareMinutes as number) > 1_440
      || !Number.isInteger(assignment.cleanupMinutes) || (assignment.cleanupMinutes as number) < 0 || (assignment.cleanupMinutes as number) > 1_440) return null;
    seen.add(assignment.resourceId);
    resources.push({ resourceId: assignment.resourceId, prepareMinutes: assignment.prepareMinutes as number, cleanupMinutes: assignment.cleanupMinutes as number });
  }
  return { bookingMode: item.bookingMode as ProductInventorySettingInput["bookingMode"], resources };
}

function snapshotDto(value: InventoryAdminSnapshot) {
  return {
    providerId: value.providerId,
    resources: value.resources.map(({ providerId, id, kind, displayName, active, version, createdAtUtc, updatedAtUtc }) => (
      { providerId, id, kind, displayName, active, version, createdAtUtc, updatedAtUtc }
    )),
    products: value.products.map(({ id, publicTitle, sellerDisplayName, status, inventory }) => ({
      id, publicTitle, sellerDisplayName, status,
      ...(inventory ? { inventory: {
        providerId: inventory.providerId, productId: inventory.productId, bookingMode: inventory.bookingMode,
        version: inventory.version, resources: inventory.resources.map(({ resourceId, prepareMinutes, cleanupMinutes }) => ({ resourceId, prepareMinutes, cleanupMinutes })),
      } } : {}),
    })),
  };
}

async function context() {
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return channelJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  const store = experienceStore();
  if (!store) return channelJson({ error: "runtime_unavailable" }, 503);
  return { store, actor: { nihoUserId: loaded.verified.actor.id } };
}

export async function GET(request: Request) {
  if (!channelManagerEnabled()) return channelJson({ error: "not_found" }, 404);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "providerId") || url.searchParams.getAll("providerId").length > 1) return channelJson({ error: "invalid_input" }, 400);
  const providerId = url.searchParams.get("providerId");
  if (providerId !== null && !identifier(providerId)) return channelJson({ error: "invalid_input" }, 400);
  const loaded = await context();
  if (loaded instanceof Response) return loaded;
  try {
    const providers = (await loaded.store.listInventoryAdminProviders(loaded.actor)).map(({ id, displayName }) => ({ id, displayName }));
    const selected = providerId === null ? null : snapshotDto(await loaded.store.getInventoryAdminSnapshot(loaded.actor, providerId));
    return channelJson({ providers, selected });
  } catch (error) {
    return channelFailure(error);
  }
}

export async function POST(request: Request) {
  if (!channelManagerEnabled()) return channelJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return channelJson({ error: "forbidden" }, 403);
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  const loaded = await context();
  if (loaded instanceof Response) return loaded;
  try {
    if (body.action === "saveResource" && exactKeys(body, ["action", "providerId", "commandId", "expectedVersion", "resource"])) {
      const resource = resourceInput(body.resource);
      if (!identifier(body.providerId) || !UUID_V4.test(String(body.commandId)) || !expectedVersion(body.expectedVersion) || !resource) return channelJson({ error: "invalid_input" }, 400);
      return channelJson({ receipt: await loaded.store.saveInventoryResourceAsAdmin(
        loaded.actor, body.providerId, resource, body.expectedVersion, String(body.commandId),
      ) }, body.expectedVersion === null ? 201 : 200);
    }
    if (body.action === "saveProductInventory" && exactKeys(body, ["action", "providerId", "productId", "commandId", "expectedVersion", "inventory"])) {
      const inventory = inventoryInput(body.inventory);
      if (!identifier(body.providerId) || !identifier(body.productId) || !UUID_V4.test(String(body.commandId)) || !expectedVersion(body.expectedVersion) || !inventory) return channelJson({ error: "invalid_input" }, 400);
      return channelJson({ receipt: await loaded.store.saveProductInventorySettingAsAdmin(
        loaded.actor, body.providerId, body.productId, inventory, body.expectedVersion, String(body.commandId),
      ) }, body.expectedVersion === null ? 201 : 200);
    }
    return channelJson({ error: "invalid_input" }, 400);
  } catch (error) {
    return channelFailure(error);
  }
}
