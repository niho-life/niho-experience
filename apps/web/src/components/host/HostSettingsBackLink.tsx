"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { nihoIdOrNull } from "@/lib/host/providers";
import { HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import { HostIcon } from "./HostIcon";

/** Settings destinations keep the same provider when returning to the overview. */
export function HostSettingsBackLink({ providerId, desktopOnly = false }: { providerId?: string; desktopOnly?: boolean }) {
  const query = useSearchParams();
  const selectedId = providerId ?? nihoIdOrNull(query.get("providerId"));
  return <Link href={withProvider(HOST_SETTINGS_PATH, selectedId)} className={`${desktopOnly ? "hidden md:inline-flex" : "inline-flex"} mb-2 min-h-11 items-center gap-1 text-sm font-bold text-ink-soft hover:text-ink`}>
    <HostIcon name="chevronLeft" className="size-4" />設定へ戻る
  </Link>;
}
