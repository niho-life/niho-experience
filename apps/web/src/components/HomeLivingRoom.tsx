import type { ReactNode } from "react";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { ButtonLink } from "@/components/ui";
import { HOME_LIVING_ROOM } from "@/lib/site-media";

type LivingRoomText = Readonly<{ hand?: string; title?: ReactNode; body?: string; action?: { href: string; label: string }; alt?: string; titleClassName?: string; card?: boolean }>;

/**
 * The shared living-room home section (#646, #658): one still photo with no animation. The English home uses the full-width band;
 * the Japanese home passes its copy and uses the card variant beside group inquiries when they are open (#672).
 */
export function HomeLivingRoom({ hand = "it starts here", title = <>NIHO, the town&rsquo;s living room</>, body = "Two minutes from Kamakura Station. People of the town drop in to cook, talk and make things together.", action = { href: "/about", label: "About NIHO Travel" }, alt = HOME_LIVING_ROOM.alt, titleClassName = "mt-1 max-w-[16ch] text-[2.25rem] leading-[1.05] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:text-[3.5rem]", card = false }: LivingRoomText = {}) {
  const { Image } = PRESENTATION_PRIMITIVES_V1;
  return <section className={card
    ? "relative flex min-h-72 items-end overflow-hidden rounded-[22px] bg-[#222] text-white"
    : "relative mt-14 min-h-[460px] overflow-hidden bg-[#222] text-white lg:mt-[88px] lg:min-h-[600px]"
  } aria-labelledby="home-living-room">
    <Image src={HOME_LIVING_ROOM.src} alt={alt} sizes={card ? "(min-width: 768px) 50vw, 100vw" : "100vw"} className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: HOME_LIVING_ROOM.position }} />
    <div aria-hidden className={card ? "absolute inset-0 bg-gradient-to-t from-black/85 to-black/10" : "absolute inset-0 bg-[linear-gradient(90deg,rgb(0_0_0/0.66),rgb(0_0_0/0.2)_75%)]"} />
    <div className={card ? "relative z-[2] p-6 sm:p-8" : "absolute inset-0 z-[2] flex items-center"}>
      <div className={card ? undefined : "container-page"}>
        <p className="hand text-[1.75rem] text-leaf">{hand}</p>
        <h2 id="home-living-room" className={card ? "mt-1 text-[1.75rem] leading-tight sm:text-[2rem]" : titleClassName}>{title}</h2>
        <p className="mt-3.5 max-w-[30rem] text-[1.0625rem] text-white/90">{body}</p>
        <p className="mt-6"><ButtonLink href={action.href}>{action.label}</ButtonLink></p>
      </div>
    </div>
  </section>;
}
