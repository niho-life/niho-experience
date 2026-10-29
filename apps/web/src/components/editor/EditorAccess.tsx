/* eslint-disable @next/next/no-html-link-for-pages -- Editor access links use full document navigation. */
import type { ReactNode } from "react";
import { EDITOR_LOGIN_PATH } from "@/lib/editor/routes";
import { loadEditorSession, requireEditorConsole } from "@/lib/editor/server";

export async function EditorAccess({ children }: { children: ReactNode }) {
  requireEditorConsole();
  const load = await loadEditorSession();
  if (load.status === "ok" || load.status === "refresh") return children;

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <section className="w-full max-w-md rounded-3xl border border-line bg-white p-7 shadow-sm">
        <p className="text-xs font-extrabold tracking-[0.08em] text-moss">NIHO EXPERIENCE</p>
        <h1 className="mt-2 font-display text-3xl font-medium">記事</h1>
        {load.status === "error" ? (
          <>
            <p role="alert" className="mt-4 text-ink-soft">接続を確認できませんでした。時間をおいてもう一度お試しください。</p>
            <a href="/editor/guides" className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full border border-line-strong px-6 font-extrabold hover:bg-sand">もう一度試す</a>
          </>
        ) : (
          <>
            <p className="mt-4 text-ink-soft">NIHOアカウントでログインしてください。</p>
            <a href={EDITOR_LOGIN_PATH} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-leaf px-6 font-extrabold hover:bg-leaf-hover">NIHOでログイン</a>
          </>
        )}
      </section>
    </main>
  );
}
