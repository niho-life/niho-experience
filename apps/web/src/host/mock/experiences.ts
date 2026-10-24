import { NO_CONDITIONS } from "../conditions";
import { listingSummary } from "../editor";
import { EMPTY_PAGE_TEXT, englishText, mapPageText, NO_ENGLISH_SOURCE } from "../page-english";
import type { HostExperience, HostExperiencePhoto, HostPageText } from "../types";

// Titles and slugs follow the pilot listings already in this public repo; the page text
// follows the provider workspace mock v2, and the photos are the site's sample photos
// (public/sample/CREDITS.md). Status, prices, schedules and dates are invented for the
// console preview, and the people in the text are left unnamed. The Japanese of the pages
// written in Japanese (#110) and the conditions are invented for the preview too.

type MockPage = Omit<HostExperience, "cover" | "schedule" | "missing">;

/** The list fields come from the page itself, so the list and the editor never disagree. */
function experience(page: MockPage): HostExperience {
  return { ...page, ...listingSummary(page) };
}

function photo(id: string, file: string, alt: string): HostExperiencePhoto {
  return { id, url: `/sample/photos/${file}`, alt };
}

const NO_MEETING = { area: "", entrance: "", exteriorPhotoUrl: null };

/** A page written in English: no Japanese, nothing drafted, no condition set. */
const WRITTEN_IN_ENGLISH = { writingLanguage: "en", japanese: null, englishSource: NO_ENGLISH_SOURCE, conditions: NO_CONDITIONS } as const;

/**
 * Community Dinner's Japanese: the host writes in Japanese and confirmed the English the site
 * shows. Each sentence matches the English below, so the preview's draft gives it back.
 */
const DINNER_JAPANESE: HostPageText = {
  title: "鎌倉の地元の人と囲むコミュニティディナー",
  lead: "地元の人のように夜を過ごしませんか。鎌倉駅から歩いて 2 分のシェアキッチンで季節の家庭料理をいっしょに作り、長いテーブルを囲んで、ここに暮らす人たちと食べて、話して、笑いましょう。",
  dayLanguage: "英語と日本語",
  highlights: [
    "鎌倉の地元の人と、季節の和食を 4〜5 品いっしょに作ります。",
    "ウェルカムドリンクを片手に、料理のこつや暮らしの話を。",
    "くつろいだコミュニティのテーブルで、みんなで食事を楽しみます。",
    "鎌倉駅の近くで、最大 8 名の少人数で参加できます。",
  ],
  description:
    "私たちのシェアリビングは、鎌倉に暮らす人たちで運営しています。週に 3 回、旅行者にキッチンを開いています。いっしょに料理して、いっしょに食べて、町に何人か知り合いができて帰る。献立はその季節とその朝の市場しだい、会話はテーブルしだいです。",
  included: ["ウェルカムドリンク", "食材と夕食のすべて", "お茶・コーヒー・地元のクラフトビール"],
  notIncluded: ["会場までの交通費", "追加のお酒"],
  notSuitableFor: ["車いすの方（会場は 2 階です）", "食物アレルギーのある方"],
  conditions: {
    PHYSICAL: "料理のあいだ 50 分ほど立ちます。",
    HOST_LANGUAGE: "地元の人の英語の得意さはさまざまです。",
    FOOD: "食物アレルギーには対応できません。",
    ACCESS: "会場は 2 階で、階段で上がります。",
  },
  timeline: {
    "cd-step-1": { title: "ウェルカムドリンクとあいさつ", text: "地元のクラフトビールやお茶、ジュースを片手に、ホストと今夜のご近所さんに会います。" },
    "cd-step-2": { title: "いっしょに作る", text: "季節の料理を 4〜5 品、テーブルで分担して。料理の経験はいりません。" },
    "cd-step-3": { title: "座って食べる", text: "長いテーブルに、作ったばかりの料理と、鎌倉の暮らしの話。" },
    "cd-step-4": { title: "おやすみなさい、またはもう一杯のお茶", text: "たいてい誰かがギターを手に取ります。駅までは 2 分、帰りたいときにどうぞ。" },
  },
  meeting: { area: "鎌倉駅から歩いて 2 分", entrance: "建物の右側の通用口から入り、階段で 2 階へ上がってください。ドアの横の小さな看板が目印です。" },
  knowBeforeYouGo: ["献立は季節の食材の入り方で変わります。", "参加する地元の人は日によって違い、特定の人をお約束できません。", "地元の人の英語の得意さはさまざまです。"],
  offers: {
    "offer-dinner": { name: "ディナー", questions: ["食べものの希望があれば教えてください"] },
    "offer-tea": { name: "ティータイム", questions: [] },
  },
};

/** The calligraphy draft's Japanese: written in Japanese, its English not made yet. */
const CALLIGRAPHY_JAPANESE: HostPageText = {
  ...EMPTY_PAGE_TEXT,
  title: "鎌倉の書家と、自分の漢字を書く",
  lead: "墨をすり、基本の筆づかいを習って、好きな漢字を書きます。鎌倉駅近くの静かなアトリエで。",
  dayLanguage: "日本語と英語",
  highlights: ["本物の筆で、基本の 8 つの筆づかいを練習します。", "書いた漢字は台紙に貼って持ち帰れます。"],
};

/** The English NIHO would draft from it: what the preview's 英語の下書きを作る gives back. */
const CALLIGRAPHY_ENGLISH: HostPageText = {
  ...EMPTY_PAGE_TEXT,
  title: "Write Your Own Kanji with a Kamakura Calligrapher",
  lead: "Grind your own ink, learn the basic strokes and write the kanji of your choice in a quiet studio near Kamakura Station.",
  dayLanguage: "Japanese and English",
  highlights: ["Practice the eight basic strokes with a real brush.", "Take home the kanji you wrote, mounted on card."],
};

export const MOCK_KITCHEN_EXPERIENCES: readonly HostExperience[] = [
  experience({
    id: "community-dinner",
    slug: "kamakura-community-dinner",
    title: "Kamakura Community Dinner with Locals",
    status: "live",
    liveSince: "2026-10-12",
    writingLanguage: "ja",
    japanese: DINNER_JAPANESE,
    englishSource: { draftedFrom: null, confirmedFrom: DINNER_JAPANESE, edited: [] },
    lead: "Spend an evening the way locals do. Cook a seasonal, home-style Japanese dinner together in a shared kitchen two minutes from Kamakura Station, then sit down at one long table to eat, talk and laugh with the people who live here.",
    dayLanguage: "English and Japanese",
    highlights: [
      "Cook four or five seasonal Japanese dishes with Kamakura locals.",
      "Share a welcome drink, cooking tips, and stories of everyday life.",
      "Enjoy the meal together at a relaxed community table.",
      "Join a small group of up to eight people near Kamakura Station.",
    ],
    description:
      "Our shared living room is run by people who live in Kamakura. Three evenings a week we open the kitchen to travelers: you cook with us, eat with us and leave knowing a few people in town. The menu follows the season and the market that morning; the conversation follows the table.",
    included: ["Welcome drink", "All ingredients and dinner", "Tea, coffee and local craft beer"],
    notIncluded: ["Transport to the venue", "Extra alcoholic drinks"],
    notSuitableFor: ["Wheelchair users (the venue is on the second floor)", "Guests with food allergies"],
    conditions: {
      AGE: { minimumAge: null, withAdult: true, note: "" },
      PHYSICAL: { seating: "CHAIR", seatedMinutes: 60, walking: "LITTLE", note: "You stand for about 50 minutes while we cook." },
      HOST_LANGUAGE: { japanese: true, english: "CONVERSATIONAL", englishGuide: false, note: "English fluency varies among community members." },
      FOOD: { served: "MEAL", diets: ["VEGETARIAN"], note: "We cannot cater for food allergies." },
      ACCESS: { access: "STEPS", note: "The venue is on the second floor, up a flight of stairs." },
      WEATHER: { rain: "INDOOR", note: "" },
    },
    timeline: [
      { id: "cd-step-1", time: "18:00", title: "Welcome drink & hellos", text: "Meet your hosts and tonight’s neighbors over a local craft beer, tea or juice." },
      { id: "cd-step-2", time: "18:20", title: "Cook together", text: "Four or five seasonal dishes, split across the table. Nobody needs to know how to cook." },
      { id: "cd-step-3", time: "19:15", title: "Sit down and eat", text: "One long table, everything you just made, and stories of everyday life in Kamakura." },
      { id: "cd-step-4", time: "20:00", title: "Goodnight — or one more cup of tea", text: "Someone usually picks up the guitar. The station is two minutes away whenever you’re ready." },
    ],
    meeting: {
      area: "Near Kamakura Station, 2-minute walk",
      entrance: "Use the side entrance on the right of the building and take the stairs to the second floor. Look for the small sign by the door.",
      exteriorPhotoUrl: "/sample/photos/niho-exterior.jpg",
    },
    knowBeforeYouGo: [
      "The menu changes with seasonal ingredient availability.",
      "Community members vary by date; specific people cannot be guaranteed.",
      "English fluency varies among community members.",
    ],
    photos: [
      photo("cd-1", "niho-cd-table-01.jpg", "Dinner laid out on the long table"),
      photo("cd-2", "niho-cd-kitchen-together.jpg", "Cooking together in the shared kitchen"),
      photo("cd-3", "niho-cd-food-trays.jpg", "Trays of dishes made together"),
      photo("cd-4", "niho-dinner-1.jpg", "Welcome drinks in the living room"),
      photo("cd-5", "niho-cd-hands-salad.jpg", "Hands dressing a salad"),
      photo("cd-6", "niho-dinner-5.jpg", "Talking in the living room"),
      photo("cd-7", "niho-cd-strawberry-daifuku.jpg", "Strawberry daifuku for dessert"),
      photo("cd-8", "niho-cd-table-02.jpg", "Neighbors around the long table"),
    ],
    offers: [
      {
        id: "offer-dinner",
        name: "Dinner",
        adultPriceYen: 30000,
        childPriceYen: 12000,
        capacity: 8,
        startTime: "18:00",
        durationMinutes: 120,
        weekdays: [2, 4, 6],
        closedDates: ["2026-12-31", "2027-01-01"],
        questions: ["Any dietary preferences we should know about?"],
      },
      { id: "offer-tea", name: "tea time", adultPriceYen: 15000, childPriceYen: null, capacity: 8, startTime: "13:00", durationMinutes: 120, weekdays: [0], closedDates: [], questions: [] },
    ],
  }),
  experience({
    id: "kintsugi",
    slug: "kamakura-ceramic-mending",
    title: "Mend a Broken Bowl with a Kamakura Restorer",
    status: "review",
    requestedOn: "2026-10-19",
    ...WRITTEN_IN_ENGLISH,
    lead: "Learn the basics of kintsugi with a restorer who has mended Kamakura’s bowls for twenty years. Bring a chipped piece from home or pick one from the studio shelf.",
    dayLanguage: "Japanese, with basic English",
    highlights: ["Mend a real chipped bowl with lacquer and gold powder.", "Two hours in a working studio, four guests at most."],
    description:
      "The studio sits on a quiet street behind Komachi-dori. You will clean the chip, build it up with lacquer and finish it with gold. The lacquer cures for a week, then we ship the bowl to you.",
    included: ["A bowl to mend", "All materials", "Tea"],
    notIncluded: ["Transport", "Shipping outside Japan"],
    notSuitableFor: [],
    timeline: [
      { id: "kt-step-1", time: "10:00", title: "Hello and tea", text: "A cup of tea while your host shows a few mended pieces." },
      { id: "kt-step-2", time: "10:20", title: "Mend", text: "Clean, fill, lacquer, gold." },
    ],
    meeting: { area: "Komachi-dori area, 8-minute walk from Kamakura Station", entrance: "", exteriorPhotoUrl: null },
    knowBeforeYouGo: ["Lacquer takes a week to cure; the finished bowl is shipped to your home or hotel."],
    // No photos in the preview: the list shows a plain thumbnail.
    photos: [],
    offers: [{ id: "offer-workshop", name: "Workshop", adultPriceYen: 8800, childPriceYen: null, capacity: 4, startTime: "10:00", durationMinutes: 120, weekdays: [0, 6], closedDates: [], questions: [] }],
  }),
  experience({
    id: "coffee",
    slug: "kamakura-coffee-roasting",
    title: "Roast Your Own Coffee in a Kamakura Living Room",
    status: "draft",
    ...WRITTEN_IN_ENGLISH,
    lead: "",
    dayLanguage: "",
    highlights: [],
    description: "",
    included: [],
    notIncluded: [],
    notSuitableFor: [],
    timeline: [],
    meeting: NO_MEETING,
    knowBeforeYouGo: [],
    photos: [],
    offers: [],
  }),
];

export const MOCK_STUDIO_EXPERIENCES: readonly HostExperience[] = [
  experience({
    id: "calligraphy",
    slug: "kamakura-calligraphy",
    // The English title is the one the page was started with (the list names it by it); the rest of the English is not made yet.
    title: CALLIGRAPHY_ENGLISH.title,
    status: "draft",
    writingLanguage: "ja",
    japanese: CALLIGRAPHY_JAPANESE,
    englishSource: NO_ENGLISH_SOURCE,
    conditions: NO_CONDITIONS,
    lead: "",
    dayLanguage: "",
    highlights: [],
    description: "",
    included: [],
    notIncluded: [],
    notSuitableFor: [],
    timeline: [],
    meeting: NO_MEETING,
    knowBeforeYouGo: [],
    photos: [],
    offers: [],
  }),
];

/** What NIHO's draft says for Japanese the preview has no English for. */
export const PREVIEW_PAGE_ENGLISH = "[Preview] English draft from NIHO.";

/** The preview's Japanese with the English NIHO would draft from it, sentence by sentence. */
const PAGE_ENGLISH_EXAMPLES: readonly { experienceId: string; japanese: HostPageText; english: HostPageText }[] = [
  { experienceId: "community-dinner", japanese: DINNER_JAPANESE, english: englishText(MOCK_KITCHEN_EXPERIENCES[0]!) },
  { experienceId: "calligraphy", japanese: CALLIGRAPHY_JAPANESE, english: CALLIGRAPHY_ENGLISH },
];

/** Each sentence of `japanese` with the sentence in the same place of `english`. */
function sentencePairs(japanese: HostPageText, english: HostPageText): [string, string][] {
  const pairs: [string, string][] = [];
  const add = (ja: string | undefined, en: string | undefined) => {
    if (ja?.trim() && en !== undefined) pairs.push([ja.trim(), en]);
  };
  const lists = (ja: readonly string[], en: readonly string[]) => ja.forEach((value, index) => add(value, en[index]));
  for (const field of ["title", "lead", "dayLanguage", "description"] as const) add(japanese[field], english[field]);
  for (const field of ["highlights", "included", "notIncluded", "notSuitableFor", "knowBeforeYouGo"] as const) lists(japanese[field], english[field]);
  for (const [kind, note] of Object.entries(japanese.conditions)) add(note, english.conditions[kind as keyof HostPageText["conditions"]]);
  for (const [id, step] of Object.entries(japanese.timeline)) {
    add(step.title, english.timeline[id]?.title);
    add(step.text, english.timeline[id]?.text);
  }
  add(japanese.meeting.area, english.meeting.area);
  add(japanese.meeting.entrance, english.meeting.entrance);
  for (const [id, offer] of Object.entries(japanese.offers)) {
    add(offer.name, english.offers[id]?.name);
    lists(offer.questions, english.offers[id]?.questions ?? []);
  }
  return pairs;
}

/**
 * The preview's 英語の下書きを作る: each sentence of the example's Japanese becomes the example's
 * English, anything else one preview sentence; blank stays blank.
 */
export function mockPageEnglishDraft(experienceId: string, japanese: HostPageText): HostPageText {
  const known = new Map(PAGE_ENGLISH_EXAMPLES.filter((example) => example.experienceId === experienceId).flatMap((example) => sentencePairs(example.japanese, example.english)));
  return mapPageText(japanese, (value) => (value.trim() ? (known.get(value.trim()) ?? PREVIEW_PAGE_ENGLISH) : ""));
}
