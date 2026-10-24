import Link from "next/link";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { ADMIN_ENTRY_PATH } from "@/lib/admin/routes";
import { requireAdminConsole } from "@/lib/admin/server";

export default function AdminAuthErrorPage() {
  requireAdminConsole();
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-sand/45 px-4 py-10">
      <section role="alert" className={`${HOST_SURFACE} w-full max-w-lg p-6 md:p-8`}>
        <h1 className="font-display text-2xl font-medium">NIHOとの接続を完了できませんでした</h1>
        <p className="mt-3 text-ink-soft">接続の有効期限または管理者権限を確認して、もう一度お試しください。</p>
        <Link href={ADMIN_ENTRY_PATH} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-leaf px-6 font-extrabold hover:bg-leaf-hover">
          管理画面の入口へ戻る
        </Link>
      </section>
    </main>
  );
}
