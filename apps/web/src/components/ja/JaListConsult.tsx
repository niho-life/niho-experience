import Link from "next/link";

/** 日本語の一覧の末尾：探しているものが見つからないときの相談の案内（相談の窓口が開いているときだけ、呼ぶ側が渡す）。 */
export function JaListConsult() {
  return (
    <aside className="container-page mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-sand/60 px-5 py-4">
        <div><h2 className="text-[1rem] font-bold">探しているものが見つからないときは</h2><p className="text-[0.875rem] text-ink-soft">載っていない人や活動も、事務局が知っていることがあります。</p></div>
        <Link href="/ja/inquiry" className="inline-flex min-h-11 items-center rounded-full border border-line-strong bg-canvas px-5 text-[0.9375rem] font-extrabold hover:bg-sand">相談する</Link>
      </div>
    </aside>
  );
}

/** 0件のときの案内（相談の窓口が開いているとき）。 */
export function JaListEmpty({ total }: { total: number }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-sand/40 px-5 py-10 text-center">
      <span className="hand text-[1.375rem]">nothing here yet</span>
      <p className="mt-2 text-ink-soft">{total === 0 ? "いま案内できる体験がありません。" : "条件に合う体験がまだありません。"}事務局に相談すると、合う人と場をお探しします。</p>
      <Link href="/ja/inquiry" className="mt-4 inline-flex min-h-11 items-center rounded-full bg-leaf px-6 text-[0.9375rem] font-extrabold text-ink hover:bg-leaf-hover">相談する</Link>
    </div>
  );
}
