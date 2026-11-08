"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { HostProviderRole } from "@/lib/host/providers";
import { hostSettingsIndexGroups, hostSettingsSectionFromHash } from "@/lib/host/settings-navigation";
import { HOST_SURFACE } from "./host-ui";
import { HostIcon } from "./HostIcon";

export function HostSettingsIndex({ providerId, role, deviceEnabled, articlesEnabled }: {
  providerId: string;
  role: HostProviderRole | null;
  deviceEnabled: boolean;
  articlesEnabled: boolean;
}) {
  const router = useRouter();
  const groups = hostSettingsIndexGroups({ providerId, role, deviceEnabled, articlesEnabled });

  useEffect(() => {
    const section = hostSettingsSectionFromHash(window.location.hash);
    if (!section) return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", section);
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  }, [router]);

  return (
    <div className="grid gap-3.5">
      {groups.map((group) => (
        <section key={group.label} aria-labelledby={`settings-index-${group.label}`} className={`${HOST_SURFACE} overflow-hidden`}>
          <h2 id={`settings-index-${group.label}`} className="px-4 pt-4 pb-2 text-[0.78125rem] font-extrabold text-ink-soft md:px-5">{group.label}</h2>
          <ul className="divide-y divide-line">
            {group.items.map((item) => (
              <li key={item.label}>
                <Link href={item.href} aria-label={item.label} aria-describedby={`settings-description-${group.label}-${item.label}`} className="flex min-h-[64px] items-center gap-3 px-4 py-3 hover:bg-sand md:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block font-extrabold">{item.label}</span>
                    <span id={`settings-description-${group.label}-${item.label}`} className="block text-[0.78125rem] leading-normal text-muted">{item.description}</span>
                  </span>
                  <HostIcon name="chevronRight" className="size-4 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
