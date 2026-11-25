import type { ReactNode } from "react";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { ButtonLink } from "@/components/ui";
import { HOME_LIVING_ROOM } from "@/lib/site-media";

type LivingRoomText = Readonly<{ hand?: string; title?: ReactNode; body?: string; action?: { href: string; label: string }; alt?: string; titleClassName?: string }>;

/**
 * The living-room band on the home (#646): one still photo, edge to edge, no animation. Without props it is the English band;
 * the Japanese home passes its own words (#658).
 */
export function HomeLivingRoom({ hand = "it starts here", title = <>NIHO, the town&rsquo;s living room</>, body = "Two minutes from Kamakura Station. People of the town drop in to cook, talk and make things together.", action = { href: "/about", label: "About NIHO Travel" }, alt = HOME_LIVING_ROOM.alt, titleClassName = "mt-1 max-w-[16ch] text-[2.25rem] leading-[1.05] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:text-[3.5rem]" }: LivingRoomText = {}) {
  const { Image } = PRESENTATION_PRIMITIVES_V1;
  return <section className="relative mt-14 min-h-[460px] overflow-hidden bg-[#222] text-white lg:mt-[88px] lg:min-h-[600px]" aria-labelledby="home-living-room">
    <Image src={HOME_LIVING_ROOM.src} alt={alt} sizes="100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: HOME_LIVING_ROOM.position }} />
    <div aria-hidden className="absolute inset-0 bg-[linear-gradient(90deg,rgb(0_0_0/0.66),rgb(0_0_0/0.2)_75%)]" />
    <div className="absolute inset-0 z-[2] flex items-center">
      <div className="container-page">
        <p className="hand text-[1.75rem] text-leaf">{hand}</p>
        <h2 id="home-living-room" className={titleClassName}>{title}</h2>
        <p className="mt-3.5 max-w-[30rem] text-[1.0625rem] text-white/90">{body}</p>
        <p className="mt-6"><ButtonLink href={action.href}>{action.label}</ButtonLink></p>
      </div>
    </div>
  </section>;
}
