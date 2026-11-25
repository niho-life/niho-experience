import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { HOME_HERO_SLIDES } from "@/lib/site-media";

/**
 * The English home hero's two extra photos (#646), stacked over the hero photo. Decorative, lazy, and they cross-fade by
 * opacity only (`.hero-fade-2` / `.hero-fade-3` in globals.css); with reduced motion they stay hidden and the still shows.
 */
export function HomeHeroSlides() {
  const { Image } = PRESENTATION_PRIMITIVES_V1;
  return <>{HOME_HERO_SLIDES.map((slide, index) => <div key={slide.src} aria-hidden className={`absolute inset-0 hero-fade-${index + 2}`} data-hero-slide={index + 2}>
    <Image src={slide.src} alt="" sizes="100vw" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: slide.position }} />
  </div>)}</>;
}
