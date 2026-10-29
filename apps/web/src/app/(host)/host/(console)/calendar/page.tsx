import type { Metadata } from "next";
import { HostCalendarWorkspace } from "@/components/host/HostCalendarWorkspace";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { hostPageContext } from "@/host/data";
import { config } from "@/lib/config";
import { safeNihoProviderUrl } from "@/lib/safe-url";

export const metadata: Metadata = { title: "カレンダー" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function HostCalendarPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  if (!context) return null;
  if (!context.provider) return <HostRegisterPrompt title="カレンダー" />;
  const googleNotice = query.google === "failed" ? "Google カレンダーを接続できませんでした。もう一度お試しください。" : query.google === "sync-failed" ? "接続しましたが、予定を確認できませんでした。確認できるまで新しい予約は停止します。" : null;
  const legacyManagementUrl = safeNihoProviderUrl(config.nihoHostStartUrl, config.nihoWebOrigin);
  return <HostPageBody><PageHead title="カレンダー" />{googleNotice ? <p role="alert" className="mb-4 rounded-xl bg-warn-pale p-3 text-warn">{googleNotice}</p> : null}<HostCalendarWorkspace key={context.provider.id} providerId={context.provider.id} legacyManagementUrl={legacyManagementUrl} /></HostPageBody>;
}
