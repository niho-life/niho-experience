import { config } from "@/lib/config";
import { ADMIN_ENTRY_PATH } from "@/lib/admin/routes";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { requireAdminConsole } from "@/lib/admin/server";

export default function AdminLogoutUnconfirmedPage() {
  requireAdminConsole();
  const nihoUrl = new URL("/", config.nihoWebOrigin).href;
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-sand/45 px-4 py-10">
      <section role="alert" className={`${HOST_SURFACE} w-full max-w-lg p-6 md:p-8`}>
        <h1 className="font-display text-2xl font-medium">この管理画面からログアウトしました</h1>
        <p className="mt-3 text-ink-soft">この端末からはログアウト済みです。</p>
        <p className="mt-3 text-ink-soft">NIHO側の接続解除は確認できませんでした。この接続は発行から最長8時間で失効します。</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <a href={nihoUrl} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-leaf px-5 font-extrabold hover:bg-leaf-hover">NIHOへ戻る</a>
          <a href={ADMIN_ENTRY_PATH} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full border border-line-strong px-5 font-extrabold hover:bg-sand">管理画面の入口へ</a>
        </div>
      </section>
    </main>
  );
}
