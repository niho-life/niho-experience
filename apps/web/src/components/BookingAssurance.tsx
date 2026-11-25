import Link from "next/link";
import { HandIcon, type HandIconName } from "./HandIcon";

const ITEMS: { icon: HandIconName; text: string }[] = [
  { icon: "people", text: "Book as a guest" },
  { icon: "card", text: "Pay by card in yen" },
  { icon: "mail", text: "Confirmation by email" },
];

/** One reassurance line under the experience cards (English list). Icons are decorative (HandIcon is aria-hidden). */
export function BookingAssurance() {
  return (
    <section className="container-page pt-10 lg:pt-12" aria-label="How booking works">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-6">
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-bold text-ink-soft">
          {ITEMS.map((item) => (
            <li key={item.text} className="flex items-center gap-1.5"><HandIcon name={item.icon} className="size-[22px]" />{item.text}</li>
          ))}
        </ul>
        <Link href="/help" className="link-leaf w-full text-sm md:ml-auto md:w-auto">Questions before you book</Link>
      </div>
    </section>
  );
}
