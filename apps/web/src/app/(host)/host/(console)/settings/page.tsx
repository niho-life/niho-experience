import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FieldRow, FieldSection } from "@/components/host/fields";
import { HostIcon } from "@/components/host/HostIcon";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSettingsForm } from "@/components/host/HostSettingsForm";
import { HostOperatingTeamPanel } from "@/components/host/HostOperatingTeamPanel";
import { HostSupportSettingsPanel } from "@/components/host/HostSupportSettingsPanel";
import { consoleButtonClass } from "@/components/host/host-ui";
import { AccountAvatar, HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostConsoleData, loadHostPayout } from "@/host/data";
import { config } from "@/lib/config";
import { HOST_LOGOUT_PATH } from "@/lib/host/routes";
import { isHostMock } from "@/lib/host/server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";

export const metadata: Metadata = { title: "設定" };

type SearchParams = Record<string, string | string[] | undefined>;

/** Stripe's way back to this page (`?connect=`), as NIHO sets it for the account page's return and refresh URLs. */
function connectStep(value: string | string[] | undefined): "return" | "refresh" | null {
  return value === "return" || value === "refresh" ? value : null;
}

/**
 * 設定 (mock v2): provider (and its review), payout account, calendar (#109), default meeting point,
 * notifications (#109) and the NIHO account. `?connect=return` (back from Stripe's page) reads the account from Stripe
 * again first; `?connect=refresh` (its link expired) sends the host back to Stripe with a new one.
 */
export default async function HostSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  if (!context) return null;
  const { session, provider, providerNotFound } = context;
  if (!provider) return <HostRegisterPrompt title="設定" />;
  // Stripe's way back belongs to the provider it names, never to the one shown in its place.
  const connect = providerNotFound ? null : connectStep(query.connect);
  const [{ settings, googleConnection }, payout] = await Promise.all([loadHostConsoleData(provider), loadHostPayout(provider, { connect })]);
  if (payout.redirectTo) redirect(payout.redirectTo);
  const account = { displayName: session.displayName, iconUrl: session.iconUrl };

  const accountPanel = (
    <FieldSection id="settings-account" title="アカウント">
      <FieldRow label="NIHO アカウント" labelId="settings-account-label">
        <div role="group" aria-labelledby="settings-account-label" className="flex min-h-10 flex-wrap items-center gap-2.5">
          <AccountAvatar account={account} className="size-6 text-[0.75rem]" />
          <span>{account.displayName || "NIHO アカウント"}</span>
          <a href={config.nihoWebOrigin} className={consoleButtonClass("secondary", "sm")}>
            <HostIcon name="external" className="size-3.5" />
            NIHO アプリ
          </a>
        </div>
      </FieldRow>
      <div className="border-t border-line pt-3 md:pl-[184px]">
        <form method="post" action={HOST_LOGOUT_PATH} data-niho-navigation-form>
          <button type="submit" className={consoleButtonClass("ghost", "sm")}>
            ログアウト
          </button>
        </form>
      </div>
    </FieldSection>
  );

  return (
    <HostPageBody>
      <PageHead title="設定">{provider.memberRole === "OWNER" && providerOperationsEnabled() ? <a href="#settings-team" className={consoleButtonClass("secondary")}>サブホストを管理</a> : null}</PageHead>
      {/* Keyed by provider: switching providers starts from that provider's values. */}
      <HostSettingsForm
        key={provider.id}
        providerId={provider.id}
        role={provider.memberRole}
        settings={settings}
        payout={payout.load}
        connectNotice={payout.notice}
        googleConnection={googleConnection}
        preview={isHostMock()}
        account={<><HostOperatingTeamPanel providerId={provider.id} role={provider.memberRole} enabled={providerOperationsEnabled()} /><div className="mt-3.5"><HostSupportSettingsPanel providerId={provider.id} role={provider.memberRole} preview={isHostMock()} /></div><div className="mt-3.5">{accountPanel}</div></>}
      />
    </HostPageBody>
  );
}
