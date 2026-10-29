import type { ChannelCapabilities, ChannelListingInput, ExternalAccountInput } from "@niho-experience/experience-store";
import { adminMutationAllowed, loadAdminHttpSession } from "@/lib/admin/server";
import { boundedObject, channelFailure, channelJson, channelManagerEnabled, exactKeys } from "@/lib/experience/channel-runtime";
import { channelRuntime } from "@/lib/experience/store-server";

export const runtime = "nodejs";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function capabilities(value: unknown): ChannelCapabilities | null {
  const item = record(value);
  if (!item || !exactKeys(item, [], ["canObserve", "canClose", "canOpen", "canCreate"])
    || Object.values(item).some((entry) => typeof entry !== "boolean")) return null;
  return item as ChannelCapabilities;
}

function accountInput(value: unknown): ExternalAccountInput | null {
  const item = record(value);
  if (!item || !exactKeys(item, ["id", "providerId", "site", "externalAccountId", "displayName", "operatingModel"], ["active", "delegatedUntilUtc", "revokedAtUtc", "privateProfileRef"])) return null;
  if (!["id", "providerId", "site", "externalAccountId", "displayName"].every((key) => typeof item[key] === "string")
    || ![1, 2, 3, 4].includes(item.operatingModel as number)
    || (item.active !== undefined && typeof item.active !== "boolean")
    || ["delegatedUntilUtc", "revokedAtUtc", "privateProfileRef"].some((key) => item[key] !== undefined && typeof item[key] !== "string")) return null;
  return item as unknown as ExternalAccountInput;
}

function listingInput(value: unknown): ChannelListingInput | null {
  const item = record(value);
  if (!item || !exactKeys(item, ["id", "providerId", "accountId", "productId", "externalProductId", "adapter", "adapterVersion", "connectionMode"], ["externalOptionId", "timeZone", "capabilities", "active"])) return null;
  if (!["id", "providerId", "accountId", "productId", "externalProductId", "adapter", "adapterVersion"].every((key) => typeof item[key] === "string")
    || !["BROWSER", "GOOGLE", "API"].includes(item.connectionMode as string)
    || (item.externalOptionId !== undefined && typeof item.externalOptionId !== "string") || (item.timeZone !== undefined && item.timeZone !== "Asia/Tokyo")
    || (item.active !== undefined && typeof item.active !== "boolean")) return null;
  const parsedCapabilities = item.capabilities === undefined ? {} : capabilities(item.capabilities);
  if (!parsedCapabilities) return null;
  return { ...(item as unknown as ChannelListingInput), capabilities: parsedCapabilities };
}

function command(body: Record<string, unknown>): string | null {
  return typeof body.commandId === "string" ? body.commandId : null;
}

function accountDto(value: Awaited<ReturnType<NonNullable<ReturnType<typeof channelRuntime>>["createExternalAccount"]>>) {
  const { id, providerId, site, externalAccountId, displayName, operatingModel, active, delegatedUntilUtc, revokedAtUtc, version, quarantined, createdAtUtc, updatedAtUtc } = value;
  return { id, providerId, site, externalAccountId, displayName, operatingModel, active,
    ...(delegatedUntilUtc === undefined ? {} : { delegatedUntilUtc }), ...(revokedAtUtc === undefined ? {} : { revokedAtUtc }),
    version, quarantined, createdAtUtc, updatedAtUtc };
}

function listingDto(value: Awaited<ReturnType<NonNullable<ReturnType<typeof channelRuntime>>["createListing"]>>) {
  const { id, providerId, accountId, productId, externalProductId, externalOptionId, timeZone, adapter, adapterVersion, connectionMode, capabilities, active, mappingVersion, createdAtUtc, updatedAtUtc } = value;
  return { id, providerId, accountId, productId, externalProductId, ...(externalOptionId === undefined ? {} : { externalOptionId }),
    timeZone, adapter, adapterVersion, connectionMode, capabilities, active, mappingVersion, createdAtUtc, updatedAtUtc };
}

export async function POST(request: Request) {
  if (!channelManagerEnabled()) return channelJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return channelJson({ error: "forbidden" }, 403);
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return channelJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  const runtime = channelRuntime();
  if (!runtime) return channelJson({ error: "runtime_unavailable" }, 503);
  const actor = { nihoUserId: loaded.verified.actor.id };
  try {
    if (body.action === "listAccounts" && exactKeys(body, ["action", "providerId"]) && typeof body.providerId === "string") {
      return channelJson({ accounts: (await runtime.listExternalAccounts(actor, body.providerId)).map(accountDto) });
    }
    if (body.action === "listListings" && exactKeys(body, ["action", "providerId"]) && typeof body.providerId === "string") {
      return channelJson({ listings: (await runtime.listListings(actor, body.providerId)).map(listingDto) });
    }
    if (body.action === "createAccount" && exactKeys(body, ["action", "commandId", "account"])) {
      const input = accountInput(body.account); const commandId = command(body);
      if (!input || !commandId) return channelJson({ error: "invalid_input" }, 400);
      return channelJson({ account: accountDto(await runtime.createExternalAccount(actor, input, commandId)) }, 201);
    }
    if (body.action === "updateAccount" && exactKeys(body, ["action", "commandId", "accountId", "expectedVersion", "account"])) {
      const input = accountInput(body.account); const commandId = command(body);
      if (!input || input.active === undefined || !commandId || typeof body.accountId !== "string" || !Number.isSafeInteger(body.expectedVersion)) return channelJson({ error: "invalid_input" }, 400);
      const update = {
        displayName: input.displayName, operatingModel: input.operatingModel, active: input.active,
        ...(input.delegatedUntilUtc === undefined ? {} : { delegatedUntilUtc: input.delegatedUntilUtc }),
        ...(input.revokedAtUtc === undefined ? {} : { revokedAtUtc: input.revokedAtUtc }),
        ...(input.privateProfileRef === undefined ? {} : { privateProfileRef: input.privateProfileRef }),
      };
      return channelJson({ account: accountDto(await runtime.updateExternalAccount(actor, body.accountId, update, body.expectedVersion as number, commandId)) });
    }
    if (body.action === "createListing" && exactKeys(body, ["action", "commandId", "listing"])) {
      const input = listingInput(body.listing); const commandId = command(body);
      if (!input || !commandId) return channelJson({ error: "invalid_input" }, 400);
      return channelJson({ listing: listingDto(await runtime.createListing(actor, input, commandId)) }, 201);
    }
    if (body.action === "updateListing" && exactKeys(body, ["action", "commandId", "listingId", "expectedVersion", "listing"])) {
      const input = listingInput(body.listing); const commandId = command(body);
      if (!input || !commandId || typeof body.listingId !== "string" || !Number.isSafeInteger(body.expectedVersion)) return channelJson({ error: "invalid_input" }, 400);
      const update = {
        externalProductId: input.externalProductId, ...(input.externalOptionId === undefined ? {} : { externalOptionId: input.externalOptionId }),
        adapter: input.adapter, adapterVersion: input.adapterVersion, connectionMode: input.connectionMode,
        capabilities: input.capabilities ?? {}, active: input.active ?? false,
      };
      return channelJson({ listing: listingDto(await runtime.updateListing(actor, body.listingId, update, body.expectedVersion as number, commandId)) });
    }
    if (body.action === "reconcile" && exactKeys(body, ["action", "commandId", "listingId"]) && typeof body.listingId === "string" && command(body)) {
      return channelJson(await runtime.reconcileListing(actor, body.listingId, command(body)!));
    }
    if (body.action === "mintWorker" && exactKeys(body, ["action", "commandId", "workerId", "displayName", "expiresAtUtc", "expectedVersion"])
      && typeof body.workerId === "string" && typeof body.displayName === "string" && typeof body.expiresAtUtc === "string"
      && (body.expectedVersion === null || Number.isSafeInteger(body.expectedVersion)) && command(body)) {
      return channelJson({ credential: await runtime.mintWorkerCredential(actor, body.workerId, body.displayName, body.expiresAtUtc, body.expectedVersion as number | null, command(body)!) }, 201);
    }
    if (body.action === "assignWorker" && exactKeys(body, ["action", "commandId", "workerId", "accountId", "expectedVersion"])
      && typeof body.workerId === "string" && typeof body.accountId === "string"
      && (body.expectedVersion === null || Number.isSafeInteger(body.expectedVersion)) && command(body)) {
      await runtime.assignWorkerAccount(actor, body.workerId, body.accountId, body.expectedVersion as number | null, command(body)!);
      return channelJson({ assigned: true });
    }
    if (body.action === "revokeWorkerAccount" && exactKeys(body, ["action", "commandId", "workerId", "accountId", "expectedVersion"])
      && typeof body.workerId === "string" && typeof body.accountId === "string" && Number.isSafeInteger(body.expectedVersion) && command(body)) {
      await runtime.revokeWorkerAccount(actor, body.workerId, body.accountId, body.expectedVersion as number, command(body)!);
      return channelJson({ revoked: true });
    }
    if (body.action === "revokeWorker" && exactKeys(body, ["action", "commandId", "workerId", "expectedVersion"])
      && typeof body.workerId === "string" && Number.isSafeInteger(body.expectedVersion) && command(body)) {
      await runtime.revokeWorker(actor, body.workerId, body.expectedVersion as number, command(body)!);
      return channelJson({ revoked: true });
    }
    if (body.action === "recover" && exactKeys(body, ["action", "commandId", "accountId", "stopConfirmed"])
      && typeof body.accountId === "string" && body.stopConfirmed === true && command(body)) {
      return channelJson(await runtime.recoverQuarantinedLease(actor, body.accountId, true, command(body)!));
    }
    return channelJson({ error: "invalid_input" }, 400);
  } catch (error) {
    return channelFailure(error);
  }
}
