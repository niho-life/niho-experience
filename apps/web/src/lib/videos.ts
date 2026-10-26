/** Approved public videos only. Add an ID after the video and its poster have publication consent. */
export type PublicVideo = Readonly<{ youtubeId: string; caption: string }>;

// The public API does not carry video yet (#152). This reviewed site registry is the temporary source.
// Keep it empty until a published video and the host's medium-specific consent are recorded.
const EXPERIENCE_VIDEOS: Readonly<Record<string, PublicVideo>> = {};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function publicVideoProblems(video: PublicVideo): string[] {
  const problems: string[] = [];
  if (!YOUTUBE_ID.test(video.youtubeId)) problems.push("youtubeId must be an 11-character YouTube ID");
  if (!video.caption.trim() || video.caption.length > 200) problems.push("caption must be 1–200 characters");
  return problems;
}

export function videoForExperience(slug: string): PublicVideo | null {
  const video = EXPERIENCE_VIDEOS[slug];
  return video && publicVideoProblems(video).length === 0 ? video : null;
}
