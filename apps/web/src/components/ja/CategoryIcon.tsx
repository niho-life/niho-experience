import type { ExperienceCategoryId } from "@niho-experience/experience-domain";

/* 手描きふうの線のアイコン（カテゴリー用）。currentColor の線だけで、色は周りの文字色に従う。 */
const PATHS: Record<ExperienceCategoryId, string> = {
  walk: "M3 19l5-9 3 5 3-6 7 10M3 19h18",
  food: "M4 11h16a8 8 0 0 1-16 0zM9 7c0-1.5 1-1.5 1-3M14 7c0-1.5 1-1.5 1-3",
  craft: "M5 19c0-3 2-4 4-5l8-9c1-1 3 0 2 2l-7 10c-1 2-3 3-7 2zM13 10l3 3",
  zen: "M12 4a8 8 0 1 0 7 4M12 4c3 0 5 2 5 4",
  time: "M18 14a7 7 0 1 1-8-9 6 6 0 0 0 8 9zM19 4v3M17.5 5.5h3",
  sea: "M3 15c2-3 4-3 6 0s4 3 6 0 4-3 6 0M3 19c2-3 4-3 6 0s4 3 6 0 4-3 6 0M12 4v6",
  people: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 2-5 5-5s5 2 5 5M13 20c0-3 2-5 4-5s4 2 4 5",
  group: "M5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM19 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 19c0-2.5 1.5-4 3.5-4M22 19c0-2.5-1.5-4-3.5-4M7 20c0-3 2-5 5-5s5 2 5 5",
};

export function CategoryIcon({ id, className = "size-5" }: { id: ExperienceCategoryId; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[id]} />
    </svg>
  );
}
