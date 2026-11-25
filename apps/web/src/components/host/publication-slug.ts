/** The page address of a new experience, made from its title (the host is not asked for one). */
const MAX_LENGTH = 36;
const TRAILING_WORDS = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to", "with"]);
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

type Random = () => number;

function randomText(length: number, chars: string, random: Random): string {
  let text = "";
  for (let at = 0; at < length; at += 1) text += chars[Math.min(chars.length - 1, Math.floor(random() * chars.length))];
  return text;
}

/** Lower-case words of letters and digits joined by hyphens, at most 36 characters and ending at a word, never on a connecting word. */
export function publicationSlugFromTitle(title: string, random: Random = Math.random): string {
  const words: string[] = [];
  for (const word of title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)) {
    if ([...words, word].join("-").length > MAX_LENGTH) {
      if (!words.length) words.push(word.slice(0, MAX_LENGTH));
      break;
    }
    words.push(word);
  }
  while (words.length > 0 && TRAILING_WORDS.has(words[words.length - 1]!)) words.pop();
  const slug = words.join("-");
  return slug.length >= 3 ? slug : `experience-${randomText(6, ID_CHARS, random)}`;
}

/** The address tried again after a conflict: the same words and a hyphen with four digits. */
export function publicationSlugRetry(slug: string, random: Random = Math.random): string {
  return `${slug}-${randomText(4, "0123456789", random)}`;
}
