import Link from "next/link";
import type { HostProviderRole } from "@/lib/host/providers";
import { hostSupportPath } from "@/lib/host/routes";
import { FieldSection } from "./fields";
import { consoleButtonClass } from "./host-ui";

export function HostSupportSettingsPanel({ providerId, role }: { providerId: string; role: HostProviderRole | null; preview: boolean }) {
  const owner = role === "OWNER";
  return <div className="mb-3.5"><FieldSection id="settings-support" title="NIHOサポート"><p className="text-[0.8125rem] text-ink-soft">サポートの利用条件と手数料は、体験の設定とは分けて確認・変更します。</p><p className="mt-3">{owner ? <Link href={hostSupportPath("EXPERIENCE_PROVIDER", providerId)} className={consoleButtonClass("secondary")}>NIHOサポート設定を開く</Link> : <span className="text-xs text-muted">この設定は現在のオーナーが確認できます。</span>}</p></FieldSection></div>;
}
