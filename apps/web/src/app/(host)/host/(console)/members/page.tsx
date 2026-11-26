import type { Metadata } from "next";
import { HostOperatingTeamPanel } from "@/components/host/HostOperatingTeamPanel";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSubHeader } from "@/components/host/HostSubHeader";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext } from "@/host/data";
import { config } from "@/lib/config";
import { hostTeamMode } from "@/lib/host/team-mode-server";
import { HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";

export const metadata: Metadata = { title: "メンバー" };

type SearchParams = Record<string, string | string[] | undefined>;

/** メンバー: who runs this provider with the OWNER (it was 設定 › チーム). The panel decides what each role sees. */
export default async function HostMembersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await hostPageContext(await searchParams);
  if (!context) return null;
  const { session, provider } = context;
  if (!provider) return <HostRegisterPrompt title="メンバー" />;
  return (
    <>
      <HostSubHeader backHref={withProvider(HOST_SETTINGS_PATH, provider.id)} backLabel="設定" title="" />
      <HostPageBody>
        <PageHead title="メンバー" />
        <p className="-mt-1.5 mb-3.5 text-ink-soft md:mb-[18px]">{provider.displayName} を一緒に運営する人です。</p>
        {/* Keyed by provider and role: switching the provider starts from that provider's own team, never from the other one's
            candidate, typed address or ended state. */}
        <HostOperatingTeamPanel key={`${provider.id}:${provider.memberRole ?? "none"}`} providerId={provider.id} role={provider.memberRole} mode={hostTeamMode(session)} invitationsEnabled={config.hostTeamInvitationsEnabled} />
      </HostPageBody>
    </>
  );
}
