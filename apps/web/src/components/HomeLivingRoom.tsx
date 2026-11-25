import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { ButtonLink } from "@/components/ui";
import { HOME_LIVING_ROOM } from "@/lib/site-media";

/** The living-room band on the English home (#646): one still photo, edge to edge, no animation. */
export function HomeLivingRoom() {
  const { Image } = PRESENTATION_PRIMITIVES_V1;
  return <section className="relative mt-14 min-h-[460px] overflow-hidden bg-[#222] text-white lg:mt-[88px] lg:min-h-[600px]" aria-labelledby="home-living-room">
    <Image src={HOME_LIVING_ROOM.src} alt={HOME_LIVING_ROOM.alt} sizes="100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: HOME_LIVING_ROOM.position }} />
    <div aria-hidden className="absolute inset-0 bg-[linear-gradient(90deg,rgb(0_0_0/0.66),rgb(0_0_0/0.2)_75%)]" />
    <div className="absolute inset-0 z-[2] flex items-center">
      <div className="container-page">
        <p className="hand text-[1.75rem] text-leaf">it starts here</p>
        <h2 id="home-living-room" className="mt-1 max-w-[16ch] text-[2.25rem] leading-[1.05] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:text-[3.5rem]">NIHO, the town&rsquo;s living room</h2>
        <p className="mt-3.5 max-w-[30rem] text-[1.0625rem] text-white/90">Two minutes from Kamakura Station. People of the town drop in to cook, talk and make things together.</p>
        <p className="mt-6"><ButtonLink href="/about">About NIHO Travel</ButtonLink></p>
      </div>
    </div>
  </section>;
}
