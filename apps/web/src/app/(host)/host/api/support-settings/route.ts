import { hostSupportSettingsFailureJson, isHostSupportSettingsEnabled, loadHostSupportSettingsClient } from "@/lib/host/support-settings-server";
import { hostNotFound, noStoreJson } from "@/lib/host/server";

export async function GET(request: Request) {
  if (!isHostSupportSettingsEnabled()) return hostNotFound();
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  const loaded = await loadHostSupportSettingsClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.list();
  return result.ok ? noStoreJson(result.data) : hostSupportSettingsFailureJson(result);
}
