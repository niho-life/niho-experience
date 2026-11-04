import { HostSupportSettings } from "@/components/host/HostSupportSettings";
import { HostExperienceSupportSettings } from "@/components/host/HostExperienceSupportSettings";
import { loadHostProviders } from "@/lib/host/server";
import { isHostSupportSettingsEnabled, isHostSupportSettingsPreview } from "@/lib/host/support-settings-server";

type SearchParams = Promise<{ hostKind?: string | string[]; hostId?: string | string[] }>;

export default async function HostSupportPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const malformedQuery = Array.isArray(query.hostKind) || Array.isArray(query.hostId);
  if (!malformedQuery && query.hostKind === "EXPERIENCE_PROVIDER" && typeof query.hostId === "string") {
    const identity = await loadHostProviders();
    const provider = identity.status === "ok" ? identity.providers.find((item) => item.id === query.hostId) : undefined;
    return <HostExperienceSupportSettings key={query.hostId} providerId={query.hostId} displayName={provider?.displayName ?? query.hostId} />;
  }
  return <HostSupportSettings
    key={JSON.stringify([query.hostKind, query.hostId])}
    enabled={isHostSupportSettingsEnabled() || isHostSupportSettingsPreview()}
    requestedKind={typeof query.hostKind === "string" ? query.hostKind : undefined}
    requestedId={typeof query.hostId === "string" ? query.hostId : undefined}
    malformedQuery={malformedQuery}
  />;
}
