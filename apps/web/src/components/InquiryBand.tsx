import Link from "next/link";
import { buttonClass } from "@/components/ui";
import { inquiryHref } from "@/lib/group-inquiry-entry";

/** The /ja top page's invitation to talk to NIHO (#532): for schools, companies and groups, and a free first conversation. */
export function InquiryBand() {
  return (
    <section aria-labelledby="inquiry-band" className="mx-auto my-12 w-full max-w-[64rem] px-4">
      <div className="rounded-[22px] bg-leaf-pale px-6 py-8 sm:px-10">
        <h2 id="inquiry-band" className="text-[1.5rem]">学校・会社・グループで、体験を探しているときは</h2>
        <p className="mt-2 max-w-[40rem] text-ink-soft">体験を選び切れなくても、日にちが決まっていなくても大丈夫です。目的を聞かせてください。はじめの相談は無料です。</p>
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          <a href={inquiryHref("ja")} className={buttonClass("primary", "w-full sm:w-auto")}>相談する</a>
          <Link href="/ja/business" className="font-extrabold underline underline-offset-4">法人・団体の方へ</Link>
          <Link href="/ja/schools" className="font-extrabold underline underline-offset-4">学校の方へ</Link>
        </div>
      </div>
    </section>
  );
}
