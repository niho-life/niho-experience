import { redirect } from "next/navigation";
import { AdminRefreshGate, AdminSessionEndGate } from "@/components/admin/AdminSessionKeeper";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { ADMIN_BOOKINGS_PATH, ADMIN_LOGIN_PATH } from "@/lib/admin/routes";
import { isAdminHttp, isAdminPreview, loadAdminHttpSession, readAdminSession, requireAdminConsole } from "@/lib/admin/server";

export default async function AdminEntryPage() {
  requireAdminConsole();
  if (isAdminPreview()) {
    const session = await readAdminSession();
    if (session) redirect(ADMIN_BOOKINGS_PATH);
    return <main id="main" className="grid min-h-dvh place-items-center bg-sand/45 px-4 py-10"><section className={`${HOST_SURFACE} w-full max-w-lg p-6 md:p-8`}><p className="text-xs font-extrabold tracking-[0.08em] text-moss">NIHO EXPERIENCE</p><h1 className="mt-2 font-display text-2xl font-medium">予約支援の管理画面</h1><p className="mt-3 text-ink-soft">全ホストの予約を確認し、サポートONで受け付けた予約の支援を行う合成プレビューです。</p><form method="post" action="/admin/auth/mock-login" className="mt-6"><button type="submit" className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-leaf px-6 font-extrabold hover:bg-leaf-hover">合成Adminとして開く</button></form><p className="mt-3 text-xs text-muted">実データ・実決済・外部への連絡は行いません。</p></section></main>;
  }
  if (!isAdminHttp()) return null;
  const load = await loadAdminHttpSession();
  if (load.status === "ok") redirect(ADMIN_BOOKINGS_PATH);
  if (load.status === "refresh") return <main id="main" className="grid min-h-dvh place-items-center bg-sand/45 px-4 py-10"><section className={`${HOST_SURFACE} w-full max-w-lg p-6 md:p-8`}><AdminRefreshGate /></section></main>;
  if (load.status === "rejected") return <main id="main" className="grid min-h-dvh place-items-center bg-sand/45 px-4 py-10"><section className={`${HOST_SURFACE} w-full max-w-lg p-6 md:p-8`}><AdminSessionEndGate /></section></main>;
  return <main id="main" className="grid min-h-dvh place-items-center bg-sand/45 px-4 py-10"><section className={`${HOST_SURFACE} w-full max-w-lg p-6 md:p-8`}><p className="text-xs font-extrabold tracking-[0.08em] text-moss">NIHO EXPERIENCE</p><h1 className="mt-2 font-display text-2xl font-medium">予約支援の管理画面</h1><p className="mt-3 text-ink-soft">NIHOで管理者権限を確認して接続します。接続は8時間で終了します。</p>{load.status === "error" ? <p role="alert" className="mt-3 text-sm font-bold text-warn">現在の接続を確認できませんでした。再接続すると新しいセッションを開始します。</p> : null}<a href={ADMIN_LOGIN_PATH} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-leaf px-6 font-extrabold hover:bg-leaf-hover">NIHOでログイン</a><p className="mt-3 text-xs text-muted">予約の参照・操作APIは準備中です。</p></section></main>;
}

