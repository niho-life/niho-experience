import {
  decodeExperienceHostSupportSettingsPutRequest,
  isExperienceHostSupportSettingsHostKind,
  isExperienceHostSupportSettingsPathId,
} from "@niho-experience/api-client/host-support-settings-schema";
import { readBoundedJson } from "@/lib/host/bounded-json";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { hostSupportSettingsFailureJson, isHostSupportSettingsEnabled, loadHostSupportSettingsClient } from "@/lib/host/support-settings-server";
import { hostNotFound, noStoreJson, siteOrigin } from "@/lib/host/server";

type Context = { params: Promise<{ hostKind: string; hostId: string }> };
const MAX_COMMAND_BYTES = 4096;

async function target(context: Context) {
  const { hostKind, hostId } = await context.params;
  return isExperienceHostSupportSettingsHostKind(hostKind) && isExperienceHostSupportSettingsPathId(hostId) ? { hostKind, hostId } : null;
}

export async function GET(request: Request, context: Context) {
  if (!isHostSupportSettingsEnabled()) return hostNotFound();
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  const selected = await target(context);
  if (!selected) return noStoreJson({ error: "invalid_input" }, 400);
  const loaded = await loadHostSupportSettingsClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.get(selected.hostKind, selected.hostId);
  return result.ok ? noStoreJson(result.data) : hostSupportSettingsFailureJson(result);
}

export async function PUT(request: Request, context: Context) {
  if (!isHostSupportSettingsEnabled()) return hostNotFound();
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  if (!mutationFromSameOrigin("PUT", request.headers, siteOrigin())) return noStoreJson({ error: "forbidden" }, 403);
  const selected = await target(context);
  if (!selected) return noStoreJson({ error: "invalid_input" }, 400);
  const body = await readBoundedJson(request, MAX_COMMAND_BYTES);
  if (!body.ok) return noStoreJson({ error: body.reason === "media_type" ? "unsupported_media_type" : body.reason === "too_large" ? "body_too_large" : "invalid_input" }, body.reason === "media_type" ? 415 : body.reason === "too_large" ? 413 : 400);
  const command = decodeExperienceHostSupportSettingsPutRequest(body.value);
  if (!command) return noStoreJson({ error: "invalid_input" }, 400);
  const loaded = await loadHostSupportSettingsClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.put(selected.hostKind, selected.hostId, command);
  return result.ok ? noStoreJson(result.data, 200) : hostSupportSettingsFailureJson(result);
}
