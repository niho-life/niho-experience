import type { ReactNode } from "react";
import type { AdminSection } from "@/lib/admin/sections";
import { AdminMobileHeader, AdminSidebar, AdminTabBar, type AdminAccountKind } from "./AdminNav";

/**
 * The Admin console's frame (#542), the same as the host console's (HostShell): on PC (md and up) a 232px sidebar beside
 * the page, on phones a brand header and bottom tabs. `sections` is what this sign-in can use; it is empty while the
 * session is being refreshed or has ended, and the menu is not drawn then.
 */
export function AdminShell({ sections, actorName, accountKind, unreadCount = null, children }: { sections: readonly AdminSection[]; actorName: string | null; accountKind: AdminAccountKind; unreadCount?: number | null; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-[0.875rem] leading-[1.6] [--host-tabbar:calc(3.3125rem_+_max(0.875rem,env(safe-area-inset-bottom)))] md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <AdminSidebar sections={sections} actorName={actorName} accountKind={accountKind} unreadCount={unreadCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminMobileHeader sections={sections} actorName={actorName} accountKind={accountKind} />
        <main id="main" className="flex-1">
          {children}
        </main>
        <AdminTabBar sections={sections} unreadCount={unreadCount} />
      </div>
    </div>
  );
}
