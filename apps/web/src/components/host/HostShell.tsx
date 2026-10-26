import type { ReactNode } from "react";
import type { HostProviderChoice } from "@/lib/host/providers";
import { HostMobileHeader, HostSidebar, HostTabBar } from "./HostNav";
import type { HostAccount } from "./ui";

/**
 * The signed-in frame (mock v2 of the provider workspace, #84): on PC (md and up)
 * a 232px sidebar beside the page; on phones a brand header and five bottom tabs.
 * An account with no provider yet keeps the account/support exits, while the
 * provider-specific five-section menu stays hidden.
 */
export function HostShell({ account, providers, nihoAppUrl, preview, children }: { account: HostAccount; providers: readonly HostProviderChoice[]; nihoAppUrl: string; preview: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col text-[0.875rem] leading-[1.6] [--host-tabbar:calc(3.3125rem_+_max(0.875rem,env(safe-area-inset-bottom)))] md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <HostSidebar account={account} providers={providers} nihoAppUrl={nihoAppUrl} />
      <div className="flex min-w-0 flex-1 flex-col">
        <HostMobileHeader account={account} providers={providers} nihoAppUrl={nihoAppUrl} />
        <main id="main" className="flex-1">
          {children}
        </main>
        {preview ? (
          <p role="note" className="mx-auto w-full max-w-[1040px] px-4 pb-4 text-xs leading-snug text-muted md:px-9">
            プレビュー（合成データ）· 体験・予約・売上・口座は架空で、保存されません
          </p>
        ) : null}
        {providers.length > 0 ? <HostTabBar providers={providers} /> : null}
      </div>
    </div>
  );
}
