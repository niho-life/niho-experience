import type { HostProviderRole } from "@/lib/host/providers";
import { supportSnapshot, type HostBookingSupportView } from "./types";

export interface HostSupportSettingPreview {
  enabled: boolean;
  role: HostProviderRole | null;
}

/** Synthetic provider settings. Real values will come from the versioned NIHO admin contract. */
export function hostSupportSettingPreview(providerId: string, role: HostProviderRole | null): HostSupportSettingPreview {
  return { enabled: providerId === "sample-provider-kitchen", role };
}

const KITCHEN_SUPPORT: Readonly<Record<string, HostBookingSupportView>> = {
  "bk-2041": {
    snapshot: supportSnapshot(true, "2026-10-20T14:02"),
    consultation: "英語での事前連絡と、当日の料理補助について相談しています。",
    assignee: "NIHO サポート 佐藤",
    history: [
      { at: "2026-10-20T14:10", actor: "NIHO サポート 佐藤", text: "相談を受け付けました" },
      { at: "2026-10-20T16:35", actor: "NIHO サポート 佐藤", text: "料理補助の候補者をホストへ共有しました" },
    ],
  },
  "bk-2038": {
    // This booking keeps the earlier choice even though the provider's current setting is ON.
    snapshot: supportSnapshot(false, "2026-10-18T09:41"),
    consultation: "",
    assignee: null,
    history: [],
  },
  "bk-2033": {
    snapshot: supportSnapshot(true, "2026-10-16T19:40"),
    consultation: "旅行者からの取消依頼と返金連絡の代行を相談しています。",
    assignee: "NIHO サポート 田中",
    history: [{ at: "2026-10-20T08:20", actor: "NIHO サポート 田中", text: "取消依頼を確認しました" }],
  },
};

/** Synthetic booking-time snapshots shown only in the host preview. */
export function hostBookingSupportPreview(providerId: string, bookingId: string): HostBookingSupportView | null {
  if (providerId !== "sample-provider-kitchen") return null;
  return KITCHEN_SUPPORT[bookingId] ?? {
    snapshot: supportSnapshot(true, "2026-10-01T09:00"),
    consultation: "",
    assignee: null,
    history: [],
  };
}

