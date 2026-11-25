import Link from "next/link";
import { HandIcon, type HandIconName } from "./HandIcon";

const TEXT = {
  en: {
    label: "How booking works",
    items: [
      { icon: "people", text: "Book as a guest" },
      { icon: "card", text: "Pay by card in yen" },
      { icon: "mail", text: "Confirmation by email" },
    ],
    help: { href: "/help", label: "Questions before you book" },
  },
  ja: {
    label: "予約のしくみ",
    items: [
      { icon: "people", text: "アカウント不要、ゲストとして予約" },
      { icon: "card", text: "日本円でカード払い" },
      { icon: "mail", text: "確認メールをお届け" },
    ],
    help: { href: "/ja/help", label: "予約の前のご質問" },
  },
} as const satisfies Record<"en" | "ja", { label: string; items: readonly { icon: HandIconName; text: string }[]; help: { href: string; label: string } }>;

/** One reassurance line under the experience cards, in both languages (#658). Icons are decorative (HandIcon is aria-hidden). */
export function BookingAssurance({ locale = "en" }: { locale?: "en" | "ja" }) {
  const text = TEXT[locale];
  return (
    <section className="container-page pt-10 lg:pt-12" aria-label={text.label}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-6">
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-bold text-ink-soft">
          {text.items.map((item) => (
            <li key={item.text} className="flex items-center gap-1.5"><HandIcon name={item.icon} className="size-[22px]" />{item.text}</li>
          ))}
        </ul>
        <Link href={text.help.href} className="link-leaf w-full text-sm md:ml-auto md:w-auto">{text.help.label}</Link>
      </div>
    </section>
  );
}
