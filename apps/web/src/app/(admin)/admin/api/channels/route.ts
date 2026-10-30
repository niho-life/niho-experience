import type {
  ChannelCapabilities,
  ChannelListingInput,
  ChannelRuntimeOverview,
  ConflictCaseView,
  ExternalAccountInput,
  ManualConflictResolution,
  PropagationMetrics,
} from "@niho-experience/experience-store";
import { adminMutationAllowed, loadAdminHttpSession } from "@/lib/admin/server";
import { boundedObject, channelFailure, channelJson, channelManagerEnabled, exactKeys } from "@/lib/experience/channel-runtime";
import { channelRuntime } from "@/lib/experience/store-server";

export const runtime = "nodejs";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INCIDENT_ID = /^[1-9][0-9]{0,17}$/;
/** CONFLICT_CLEARED is set only by the watchdog when the conflict is gone. */
const MANUAL_RESOLUTIONS: readonly ManualConflictResolution[] = ["CUSTOMER_CONTACTED", "ACCEPTED_BOTH", "CANCELLED_AT_SOURCE"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function capabilities(value: unknown): ChannelCapabilities | null {
  const item = record(value);
  if (!item || !exactKeys(item, [], ["canObserve", "canReadReservations", "canClose", "canOpen", "canCreate"])
    || Object.values(item).some((entry) => typeof entry !== "boolean")) return null;
  return item as ChannelCapabilities;
}

function accountInput(value: unknown): ExternalAccountInput | null {
  const item = record(value);
  if (!item || !exactKeys(item, ["id", "providerId", "site", "externalAccountId", "displayName", "operatingModel"], ["active", "delegatedUntilUtc", "revokedAtUtc"])) return null;
  if (!["id", "providerId", "site", "externalAccountId", "displayName"].every((key) => typeof item[key] === "string")
    || ![1, 2, 3, 4].includes(item.operatingModel as number)
    || (item.active !== undefined && typeof item.active !== "boolean")
    || ["delegatedUntilUtc", "revokedAtUtc"].some((key) => item[key] !== undefined && typeof item[key] !== "string")) return null;
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
  return typeof body.commandId === "string" && UUID_V4.test(body.commandId) ? body.commandId : null;
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

/** Explicit allowlist: worker credentials, private profile refs, and external account IDs never reach the browser. */
function runtimeOverviewDto(value: ChannelRuntimeOverview) {
  return {
    providerId: value.providerId, generatedAtUtc: value.generatedAtUtc,
    ...(value.watchdogLastRunAtUtc === undefined ? {} : { watchdogLastRunAtUtc: value.watchdogLastRunAtUtc }),
    watchdogStale: value.watchdogStale, openHold: value.openHold, unclosedOccurrences: value.unclosedOccurrences,
    workers: value.workers.map(({ id, displayName, lastHeartbeatAtUtc, health, openHold, openHoldSinceUtc, assignedAccounts }) => ({
      id, displayName, ...(lastHeartbeatAtUtc === undefined ? {} : { lastHeartbeatAtUtc }), health, openHold,
      ...(openHoldSinceUtc === undefined ? {} : { openHoldSinceUtc }), assignedAccounts,
    })),
    accounts: value.accounts.map(({ id, site, displayName, active, version, quarantineReason, quarantinedAtUtc, sync, reservationReads, listings }) => ({
      id, site, displayName, active, version,
      ...(quarantineReason === undefined ? {} : { quarantineReason }), ...(quarantinedAtUtc === undefined ? {} : { quarantinedAtUtc }),
      sync: {
        closePending: sync.closePending, openPending: sync.openPending, overdue: sync.overdue, heldOpen: sync.heldOpen,
        ...(sync.oldestChangedAtUtc === undefined ? {} : { oldestChangedAtUtc: sync.oldestChangedAtUtc }),
      },
      reservationReads: {
        listings: reservationReads.listings, halted: reservationReads.halted,
        ...(reservationReads.lastSuccessAtUtc === undefined ? {} : { lastSuccessAtUtc: reservationReads.lastSuccessAtUtc }),
        ...(reservationReads.nextDueAtUtc === undefined ? {} : { nextDueAtUtc: reservationReads.nextDueAtUtc }),
        ...(reservationReads.freshUntilUtc === undefined ? {} : { freshUntilUtc: reservationReads.freshUntilUtc }),
      },
      listings: listings.map(({ listingId, productTitle, closePending, openPending, overdue, reservationReads: reads, readHalted, readLastError }) => ({
        listingId, productTitle, closePending, openPending, overdue, reservationReads: reads, readHalted,
        ...(readLastError === undefined ? {} : { readLastError }),
      })),
    })),
    incidents: value.incidents.map(({ id, kind, subjectType, subjectId, openedAtUtc, escalated, acknowledged, assignedToMe, detail }) => ({
      id, kind, subjectType, subjectId, openedAtUtc, escalated, acknowledged, assignedToMe, detail,
    })),
  };
}

/** Explicit allowlist. The store holds no customer data; external account IDs are never sent to the browser. */
function conflictCaseDto(value: ConflictCaseView) {
  return {
    id: value.id, productId: value.productId, productTitle: value.productTitle, occurrenceId: value.occurrenceId,
    ...(value.occurrenceStartAtUtc === undefined ? {} : { occurrenceStartAtUtc: value.occurrenceStartAtUtc }),
    status: value.status, openedAtUtc: value.openedAtUtc, lastSeenAtUtc: value.lastSeenAtUtc,
    acknowledged: value.acknowledged, assignedToMe: value.assignedToMe,
    ...(value.resolvedAtUtc === undefined ? {} : { resolvedAtUtc: value.resolvedAtUtc }),
    ...(value.resolution === undefined ? {} : { resolution: value.resolution }),
    members: value.members.map((member) => member.kind === "EXTERNAL"
      ? { kind: member.kind, site: member.site, externalReservationId: member.externalReservationId, seats: member.seats, status: member.status }
      : { kind: member.kind, bookingId: member.bookingId, seats: member.seats, status: member.status }),
  };
}

function propagationMetricsDto(value: PropagationMetrics) {
  const duration = ({ count, p50Seconds, p95Seconds }: PropagationMetrics["detectionLag"]) => ({
    count, ...(p50Seconds === undefined ? {} : { p50Seconds }), ...(p95Seconds === undefined ? {} : { p95Seconds }),
  });
  return {
    providerId: value.providerId, generatedAtUtc: value.generatedAtUtc, fromUtc: value.fromUtc, windowDays: value.windowDays,
    truncated: value.truncated, counts: { ...value.counts },
    closeVerified: {
      ...duration(value.closeVerified), over60Minutes: value.closeVerified.over60Minutes,
      ...(value.closeVerified.maxSeconds === undefined ? {} : { maxSeconds: value.closeVerified.maxSeconds }),
    },
    detectionLag: duration(value.detectionLag), queueWait: duration(value.queueWait),
    bySite: value.bySite.map(({ site, count, closeVerifiedP95Seconds }) => ({
      site, count, ...(closeVerifiedP95Seconds === undefined ? {} : { closeVerifiedP95Seconds }),
    })),
    open: { count: value.open.count, ...(value.open.oldestAgeSeconds === undefined ? {} : { oldestAgeSeconds: value.open.oldestAgeSeconds }) },
  };
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
      if (!input || input.id !== body.accountId || input.active === undefined || !commandId || typeof body.accountId !== "string" || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) return channelJson({ error: "invalid_input" }, 400);
      const update = {
        site: input.site, externalAccountId: input.externalAccountId,
        displayName: input.displayName, operatingModel: input.operatingModel, active: input.active,
        ...(input.delegatedUntilUtc === undefined ? {} : { delegatedUntilUtc: input.delegatedUntilUtc }),
        ...(input.revokedAtUtc === undefined ? {} : { revokedAtUtc: input.revokedAtUtc }),
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
      if (!input || input.id !== body.listingId || !commandId || typeof body.listingId !== "string" || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) return channelJson({ error: "invalid_input" }, 400);
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
    if (body.action === "runtimeOverview" && exactKeys(body, ["action", "providerId"]) && typeof body.providerId === "string") {
      return channelJson({ overview: runtimeOverviewDto(await runtime.runtimeOverview(actor, body.providerId)) });
    }
    if (body.action === "pauseAccount" && exactKeys(body, ["action", "commandId", "accountId", "expectedVersion"])
      && typeof body.accountId === "string" && Number.isSafeInteger(body.expectedVersion) && (body.expectedVersion as number) >= 1 && command(body)) {
      return channelJson(await runtime.pauseAccount(actor, body.accountId, body.expectedVersion as number, command(body)!));
    }
    if (body.action === "confirmReauth" && exactKeys(body, ["action", "commandId", "accountId", "stopConfirmed", "reauthConfirmed"])
      && typeof body.accountId === "string" && body.stopConfirmed === true && body.reauthConfirmed === true && command(body)) {
      return channelJson(await runtime.confirmReauth(actor, body.accountId, true, true, command(body)!));
    }
    if (body.action === "retryReservationReads" && exactKeys(body, ["action", "commandId", "listingId"])
      && typeof body.listingId === "string" && command(body)) {
      return channelJson(await runtime.retryReservationReads(actor, body.listingId, command(body)!));
    }
    if (body.action === "acknowledgeIncident" && exactKeys(body, ["action", "commandId", "incidentId"])
      && typeof body.incidentId === "string" && INCIDENT_ID.test(body.incidentId) && command(body)) {
      return channelJson(await runtime.acknowledgeIncident(actor, body.incidentId, command(body)!));
    }
    if (body.action === "conflictCases" && exactKeys(body, ["action", "providerId"]) && typeof body.providerId === "string") {
      return channelJson({ cases: (await runtime.conflictCases(actor, body.providerId)).map(conflictCaseDto) });
    }
    if (body.action === "acknowledgeConflictCase" && exactKeys(body, ["action", "commandId", "caseId"])
      && typeof body.caseId === "string" && UUID_V4.test(body.caseId) && command(body)) {
      return channelJson(await runtime.acknowledgeConflictCase(actor, body.caseId, command(body)!));
    }
    if (body.action === "resolveConflictCase" && exactKeys(body, ["action", "commandId", "caseId", "resolution"])
      && typeof body.caseId === "string" && UUID_V4.test(body.caseId) && command(body)
      && typeof body.resolution === "string" && (MANUAL_RESOLUTIONS as readonly string[]).includes(body.resolution)) {
      return channelJson(await runtime.resolveConflictCase(actor, body.caseId, body.resolution as ManualConflictResolution, command(body)!));
    }
    if (body.action === "propagationMetrics" && exactKeys(body, ["action", "providerId"]) && typeof body.providerId === "string") {
      return channelJson({ metrics: propagationMetricsDto(await runtime.propagationMetrics(actor, body.providerId)) });
    }
    return channelJson({ error: "invalid_input" }, 400);
  } catch (error) {
    return channelFailure(error);
  }
}
