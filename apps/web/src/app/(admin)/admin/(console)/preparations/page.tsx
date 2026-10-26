import type { Metadata } from "next";
import { AdminPreparations } from "@/components/admin/AdminPreparations";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { isPreparationUiEnabled } from "@/lib/preparations/server";

export const metadata: Metadata = { title: "掲載準備" };

export default function AdminPreparationsPage() {
  if (!isPreparationUiEnabled()) return <div className="mx-auto max-w-2xl px-4 py-12"><section className={`${HOST_SURFACE} p-6`}><h1 className="font-display text-2xl font-medium">掲載準備はまだ利用できません</h1><p className="mt-2 text-ink-soft">認証依存と共通APIの配備・受入後に、専用flagで有効にします。</p></section></div>;
  return <AdminPreparations />;
}
