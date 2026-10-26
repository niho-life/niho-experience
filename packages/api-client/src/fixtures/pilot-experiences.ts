/**
 * テストサイト用の pilot fixture（担当3：商品・集客）。
 *
 * 合成 fixture（experiences.ts）と違い、実在の提供者の体験を載せる。オーナーが各事業者から掲載の許可を得ており、
 * テストサイトへ組み込むことを決めた（2026-10-19、docs/content/README.md）。
 * - 価格・曜日・時刻・人数・取消・受付方式は担当3の推奨値で、販売条件として確定していない（docs/content/product-ledger.md）。
 * - 題名は検索語（docs/growth/seo-content-policy.md の体験別の語）を入れた案で、オーナー承認（2026-10-26・#146）。本番の正本は
 *   NIHO 側の原稿なので、そちらは別に直す。ホストの画面の mock（apps/web/src/host/mock）は旧い題名のまま（ホストがまだ直していない状態）。
 * - 写真は撮影前の仮素材（apps/web/public/sample/、出典・内容は同フォルダの CREDITS.md）。オーナー判断（2026-10-20、
 *   スマホの試作モックに見た目を合わせる）で、次のとおり使う。撮り直した写真が届いたら差し替える（docs/release-acceptance.md）。
 *   - コミュニティディナーと集合場所の外観は NIHO kamakura の自前の写真（niho-*.jpg）。NIHO の集合場所の外観は実物の建物。
 *   - ほかの体験は出典を残した無料素材。円覚寺の集合場所は参道の写真（temple-path.jpg）を使う。
 *   - ホストの顔（hosts[].avatar）は host-*.jpg。Takuya は本人の写真、Yukino・Shiryu は顔の代わりの写真で本人ではない。
 *     写真の無いホスト（Hasami・わか）は null のまま（画面は頭文字）。
 *   - 画面に「Sample photo」は出さない。仮の表示であることはフッターのプレビュー表記で伝える。
 * - レビュー・販売実績・実際の残席は入れない。
 * - 本番の表示には使わない。本番は NIHO 共通基盤に登録した原稿が正本。
 */
import type { BookingQuestion, ExperienceDetail, MeetingPoint } from "../types.ts";
import { placeholderImage, type PlaceholderImageSpec } from "../mock/placeholder-image.ts";
import {
  EMPTY_BOOKING_QUESTIONS_FINGERPRINT,
  FIXTURE_CONSENT_VERSION,
  FIXTURE_EXPERIENCE_SITE_ORIGIN,
  FIXTURE_NIHO_WEB_ORIGIN,
} from "./experiences.ts";

export const PILOT_CONTENT_STATUS = "provisional" as const;
export const PILOT_UPDATED_AT = "2026-10-19T03:00:00.000Z";

const KAMAKURA = { key: "kamakura", name: "Kamakura" } as const;

function bookingTerms(): ExperienceDetail["booking"] {
  return {
    checkoutAvailable: true,
    currency: "JPY",
    timeZone: "Asia/Tokyo",
    consentVersion: FIXTURE_CONSENT_VERSION,
    legalDocuments: [
      { kind: "TERMS", url: `${FIXTURE_NIHO_WEB_ORIGIN}/legal/terms` },
      { kind: "PRIVACY", url: `${FIXTURE_NIHO_WEB_ORIGIN}/legal/privacy` },
      { kind: "COMMERCIAL_TRANSACTIONS", url: `${FIXTURE_NIHO_WEB_ORIGIN}/legal/tokushoho` },
    ],
  };
}

function canonical(slug: string): string {
  return `${FIXTURE_EXPERIENCE_SITE_ORIGIN}/experiences/${slug}`;
}

/**
 * テストサイトのプレビューで出す仮写真の置き場（apps/web/public/sample/photos。サイトの origin から配信する）。
 * 撮り直した写真が届いたら差し替える（docs/release-acceptance.md）。撮影リストは docs/content/photo-requirements.md。
 */
export const PILOT_SAMPLE_PHOTO_PATH = "/sample/photos";

/** `samplePhoto` があればその仮写真、無ければ SVG の仮素材（data URI）。 */
export type PilotImageSpec = PlaceholderImageSpec & { samplePhoto?: string };

export const PILOT_IMAGE_SPECS = {
  dinner: [
    { name: "pilot-dinner-table", label: "Neighbors around the long table at NIHO", hue: 28, samplePhoto: "niho-cd-table-02.jpg" },
    { name: "pilot-dinner-kitchen", label: "Cooking together in the shared kitchen", hue: 18, samplePhoto: "niho-cd-kitchen-together.jpg" },
    { name: "pilot-dinner-dishes", label: "Trays of dishes made together", hue: 45, samplePhoto: "niho-cd-food-trays.jpg" },
    { name: "pilot-dinner-living-room", label: "Talking in the NIHO living room", hue: 330, samplePhoto: "niho-dinner-5.jpg" },
    { name: "pilot-niho-living-room", label: "Welcome drinks in the living room", hue: 40, samplePhoto: "niho-dinner-1.jpg" },
    { name: "pilot-niho-exterior", label: "The blue NIHO building from the street", hue: 205, samplePhoto: "niho-exterior.jpg" },
  ],
  coffee: [
    { name: "pilot-coffee-roaster", label: "Scooping roasted beans", hue: 25, samplePhoto: "coffee-scoop.jpg" },
    { name: "pilot-coffee-green-beans", label: "Coffee beans on a board", hue: 90, samplePhoto: "coffee-beans-board.jpg" },
    { name: "pilot-coffee-cooling", label: "Beans turning in the roaster drum", hue: 30, samplePhoto: "coffee-drum.jpg" },
    { name: "pilot-coffee-cup", label: "Pouring a cup of coffee", hue: 35, samplePhoto: "coffee-pour.jpg" },
    { name: "pilot-niho-exterior", label: "The blue NIHO building from the street", hue: 205, samplePhoto: "niho-exterior.jpg" },
  ],
  zen: [
    { name: "pilot-zen-meditation", label: "Sitting zazen in a temple hall", hue: 140, samplePhoto: "zazen-hall.jpg" },
    { name: "pilot-zen-grounds", label: "A bamboo grove", hue: 120, samplePhoto: "bamboo.jpg" },
    { name: "pilot-zen-talk", label: "A temple garden seen from inside", hue: 160, samplePhoto: "zen-garden-view.jpg" },
    { name: "pilot-zen-path", label: "Stone steps up to a temple gate", hue: 100, samplePhoto: "temple-path.jpg" },
  ],
  mending: [
    { name: "pilot-mending-hands", label: "Hands mending a broken bowl", hue: 15, samplePhoto: "mending-hands.jpg" },
    { name: "pilot-mending-before-after", label: "Mended plates with gold lines", hue: 50, samplePhoto: "kintsugi-plates.jpg" },
    { name: "pilot-mending-tools", label: "A mended plate", hue: 10, samplePhoto: "kintsugi-plate.jpg" },
    { name: "pilot-niho-exterior", label: "The blue NIHO building from the street", hue: 205, samplePhoto: "niho-exterior.jpg" },
  ],
  calligraphy: [
    { name: "pilot-calligraphy-brush", label: "A brush writing on paper", hue: 0, samplePhoto: "calligraphy-brush.jpg" },
    { name: "pilot-calligraphy-tools", label: "Practice strokes on grid paper", hue: 220, samplePhoto: "calligraphy-grid.jpg" },
    { name: "pilot-calligraphy-work", label: "A large finished piece", hue: 260, samplePhoto: "calligraphy-large.jpg" },
    { name: "pilot-niho-exterior", label: "The blue NIHO building from the street", hue: 205, samplePhoto: "niho-exterior.jpg" },
  ],
  people: [{ name: "pilot-logo-niho", label: "NIHO kamakura", hue: 210 }],
} satisfies Record<string, PilotImageSpec[]>;

function images(specs: PilotImageSpec[]) {
  return specs.map((spec) =>
    spec.samplePhoto ? { url: `${PILOT_SAMPLE_PHOTO_PATH}/${encodeURIComponent(spec.samplePhoto)}` } : placeholderImage(spec),
  );
}

/** ホストの顔（仮）。Takuya は本人、ほかは顔の代わりの写真（CREDITS.md）。写真の無いホストは null。 */
export const PILOT_HOST_PHOTOS = {
  Takuya: "host-takuya.jpg",
  Yukino: "host-yukino.jpg",
  Shiryu: "host-shiryu.jpg",
} as const;

function host(displayName: string) {
  const file = (PILOT_HOST_PHOTOS as Record<string, string | undefined>)[displayName];
  return { displayName, avatar: file ? { url: `${PILOT_SAMPLE_PHOTO_PATH}/${encodeURIComponent(file)}` } : null };
}

function person(name: string) {
  const spec = PILOT_IMAGE_SPECS.people.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`unknown placeholder ${name}`);
  return placeholderImage(spec);
}

/** NIHO kamakura の公開済みの集合案内（NIHOapp の企画ページと同じ内容）。 */
function nihoMeetingPoint(exteriorPhotoIndex: number): MeetingPoint {
  return {
    name: "NIHO kamakura",
    address: "2F, Machi no Shain Shokudo building, 11-12 Onarimachi, Kamakura, Kanagawa 248-0012",
    accessNote: "2-minute walk from Kamakura Station West Exit.",
    entranceNote:
      "NIHO is on the second floor of the blue building. Use the side entrance on the right along the blue wall, not the main entrance, and look for the small NIHO sign.",
    mapUrl: "https://maps.google.com/?cid=7560945807134405078",
    exteriorPhotoIndex,
  };
}

const NIHO_PROVIDER = {
  name: "NIHO kamakura",
  kind: "SPOT",
  tagline: "A shared living room for neighbors, two minutes from Kamakura Station.",
} as const;

/** 流入元の暫定の記録（docs/growth/funnel-measurement.md）。回答は提供者（NIHO）に届く。 */
export const PILOT_SOURCE_QUESTION: BookingQuestion = {
  id: "q_source",
  prompt: "How did you hear about this experience?",
  description: "Optional. It helps us learn which information reaches travelers.",
  inputType: "SINGLE_SELECT",
  required: false,
  options: [
    { id: "o_stay", label: "Hotel or guesthouse" },
    { id: "o_friend", label: "A friend or NIHO member" },
    { id: "o_social", label: "Instagram or other social media" },
    { id: "o_search", label: "Search engine" },
    { id: "o_guide", label: "Travel guide, blog or website" },
    { id: "o_other", label: "Other" },
  ],
};

export const PILOT_DIET_QUESTION: BookingQuestion = {
  id: "q_diet",
  prompt: "Any dietary preferences we should know about?",
  description: "We can't cater for food allergies. Let us know if you are vegetarian or avoid certain foods.",
  inputType: "SHORT_TEXT",
  required: false,
  options: [],
};

export const PILOT_CHAIR_QUESTION: BookingQuestion = {
  id: "q_chair",
  prompt: "Would you like a chair for meditation?",
  description: "Sitting on the floor is traditional, but a chair is completely fine.",
  inputType: "SINGLE_SELECT",
  required: false,
  options: [
    { id: "o_chair", label: "Yes, please prepare a chair" },
    { id: "o_floor", label: "No, I'll sit on the floor" },
    { id: "o_unsure", label: "Not sure yet" },
  ],
};

/** NIHO と同じ算出（質問の正規化 JSON の SHA-256）。test で確かめる。 */
export const PILOT_QUESTION_FINGERPRINTS = {
  dinner: "1abdbef3195f2635aed6c0eff146a22f94e0848bb9bc719f2a4f94cc75580544",
  source: "32e7faed83ad5aaa6b0cf4c6799aa4417de7d2be17e08f13c517bc47b19e8428",
  chair: "38a417f651c9f72f4358d9b394902aa547790f2421db35ba42070aa18935ee27",
} as const;

export function buildPilotExperiences(): ExperienceDetail[] {
  const dinnerPhotos = images(PILOT_IMAGE_SPECS.dinner);
  const coffeePhotos = images(PILOT_IMAGE_SPECS.coffee);
  const zenPhotos = images(PILOT_IMAGE_SPECS.zen);
  const mendingPhotos = images(PILOT_IMAGE_SPECS.mending);
  const calligraphyPhotos = images(PILOT_IMAGE_SPECS.calligraphy);
  const nihoLogo = person("pilot-logo-niho");

  return [
    {
      slug: "kamakura-community-dinner",
      title: "Kamakura Home Cooking Dinner with Locals",
      contentLanguage: "EN",
      region: { ...KAMAKURA },
      canonicalUrl: canonical("kamakura-community-dinner"),
      lead:
        "Spend an evening the way locals do. Cook a seasonal, home-style Japanese dinner together in a shared living room two minutes from Kamakura Station, then sit down at one long table to eat and talk with people who live here.",
      languageNote: "English & Japanese",
      highlights: [
        "Cook four or five seasonal Japanese home-style dishes side by side with Kamakura residents",
        "Start with a welcome drink and easy introductions",
        "Eat together at one long table and hear about everyday life in Kamakura",
        "A small group of up to 8 guests",
        "Two minutes on foot from Kamakura Station West Exit",
      ],
      timeline: [
        { time: "18:00", title: "Welcome drink and hellos", text: "Meet your hosts and tonight's neighbors over tea or juice.", photoIndex: 4 },
        {
          time: "18:15",
          title: "Cook together",
          text: "Four or five seasonal dishes in the shared kitchen. No cooking experience needed; your hosts show you each step.",
          photoIndex: 1,
        },
        { time: "19:15", title: "Sit down and eat", text: "One long table, everything you just made, and conversation about life in Kamakura.", photoIndex: 0 },
        { time: "20:00", title: "Wrap up", text: "Stay for one more cup of tea, or head back. The station is a two-minute walk away.", photoIndex: null },
      ],
      description: [
        "NIHO is a members' shared living room in Kamakura's Onarimachi neighborhood, where residents come to cook, work, read and spend time together. For this dinner, you join them.",
        "After a welcome drink and introductions, everyone moves into the shared kitchen to prepare four or five seasonal dishes. The menu follows the season. You might make vegetable tempura, miso soup, grilled fish, a salad with local vegetables or a fruit dessert. Your hosts share simple techniques and the stories behind Japanese home cooking as you work.",
        "Then you sit down together to eat. The people at the table change from evening to evening. You may meet longtime residents, people working in arts and culture, or international neighbors who have made Kamakura home. We can't promise who will be there, and that is part of what makes each dinner different.",
        "Conversation happens in English and Japanese. Some members speak English fluently, others a little, and everyone is happy to try. This dinner suits travelers who want a relaxed evening with residents rather than a formal cooking class.",
      ].join("\n\n"),
      included: [
        "Welcome drink (tea or juice)",
        "Hands-on cooking with local residents",
        "Dinner made from the dishes you cook together",
        "Ingredients and kitchen tools",
      ],
      notIncluded: ["Alcoholic drinks", "Transport to and from NIHO"],
      notSuitableFor: [
        "Wheelchair users (the living room is on the second floor)",
        "Guests with food allergies (we cook in a shared kitchen and can't prevent cross-contact)",
        "Children under 6",
      ],
      knowBeforeYouGo: [
        "The menu changes with the season.",
        "The community members who join vary by date, so we can't guarantee who you will meet.",
        "English fluency varies among community members.",
        "You'll wear slippers inside, as in a Japanese home.",
        "Children aged 6 to 17 are welcome with an adult.",
        "We run in any weather. If a storm or emergency warning is in effect for Kamakura three hours before the start, we cancel and offer a full refund or another date.",
        "Please arrive on time. We start cooking no later than 15 minutes after the start time.",
        "Smoking is not permitted.",
      ],
      cover: dinnerPhotos[0] ?? null,
      photos: dinnerPhotos,
      meetingPointDisclosure: "PUBLIC",
      meetingPoint: nihoMeetingPoint(5),
      hosts: [
        host("Takuya"),
        host("Hasami"),
        host("わか"),
      ],
      provider: { ...NIHO_PROVIDER, logo: nihoLogo },
      seller: { displayName: "Panasonic Holdings Corporation", legalNoticeUrl: `${FIXTURE_NIHO_WEB_ORIGIN}/legal/tokushoho` },
      offers: [
        {
          id: "offer_community_dinner",
          name: "Community dinner",
          shortDescription: "About two hours, from the welcome drink to dinner.",
          pricing: {
            currency: "JPY",
            taxIncluded: true,
            // NIHOappの企画ページの金額（オーナー確認 2026-10-19）。子どもの年齢範囲は推奨値のまま。
            adultPriceYen: 30000,
            child: { priceYen: 12000, minAge: 6, maxAge: 17, adultRequired: true },
          },
          capacity: 8,
          maxPartySize: 8,
          minimumParticipants: 1,
          durationMinutes: 120,
          startTime: "18:00",
          weekdays: [2, 4, 6],
          cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 },
          acceptanceMode: "APPROVAL",
          bookingQuestions: [PILOT_DIET_QUESTION, PILOT_SOURCE_QUESTION],
          bookingQuestionsFingerprint: PILOT_QUESTION_FINGERPRINTS.dinner,
        },
      ],
      booking: bookingTerms(),
      updatedAt: PILOT_UPDATED_AT,
    },
    {
      slug: "kamakura-coffee-roasting",
      title: "Kamakura Coffee Roasting Workshop",
      contentLanguage: "EN",
      region: { ...KAMAKURA },
      canonicalUrl: canonical("kamakura-coffee-roasting"),
      lead:
        "Turn pale green coffee beans into your own roast in a shared living room two minutes from Kamakura Station. Watch the color change, listen for the crack, decide when to stop, and take your coffee home.",
      languageNote: "English & Japanese",
      highlights: [
        "See and smell green coffee beans before they are roasted",
        "Roast your own batch on a beginner-friendly roaster set up from a smartphone",
        "Listen for the first and second crack and choose your roast, from light to dark",
        "Take home 100 g of the beans you roasted",
        "Enjoy a cup of coffee in NIHO's living room",
      ],
      timeline: [
        { time: "14:00", title: "Meet the beans", text: "Look at and smell green specialty coffee beans and hear where they come from.", photoIndex: 1 },
        {
          time: "14:15",
          title: "Roast",
          text: "Set up the roaster, then watch, listen and smell as the beans change. Each roast takes about 10 to 15 minutes.",
          photoIndex: 0,
        },
        { time: "14:45", title: "Cool and pack", text: "Cool the beans quickly to keep the aroma in, then bag them to take home.", photoIndex: 2 },
        {
          time: "15:00",
          title: "Coffee time",
          text: "Enjoy a cup brewed from beans roasted earlier, because fresh beans taste best after a few days' rest.",
          photoIndex: 3,
        },
      ],
      description: [
        "Most coffee drinkers have never seen a green coffee bean. Raw, it smells more like grass than coffee. Heat changes it completely, and in about a quarter of an hour the roast creates the caramel, fruit and nutty notes you know.",
        "At NIHO, a shared living room near Kamakura Station, members buy green specialty beans and roast them on a simple roaster that anyone can use. In this session, a NIHO host explains what happens inside the bean as it heats, and then you roast your own batch. You'll listen for the first crack, when the beans start to pop and the aroma opens up, and decide whether to stop there for a light roast or keep going toward a darker one.",
        "When the beans have cooled, you pack them to take home. NIHO buys its green beans from a supplier that focuses on fair trade.",
      ].join("\n\n"),
      included: ["100 g of green specialty coffee beans", "Use of the roaster", "A bag to take your roasted beans home", "A cup of coffee"],
      notIncluded: ["Transport to and from NIHO"],
      notSuitableFor: ["Guests under 18 (the roaster gets very hot)", "Wheelchair users (the living room is on the second floor)"],
      knowBeforeYouGo: [
        "The roaster and beans get very hot. Please follow your host's instructions.",
        "Roasting makes some smoke and papery chaff. Your clothes may smell a little of coffee.",
        "Freshly roasted beans usually taste best after resting for a few days.",
        "If you are taking the beans abroad, check your home country's rules on bringing in food.",
        "You'll wear slippers inside, as in a Japanese home.",
      ],
      cover: coffeePhotos[0] ?? null,
      photos: coffeePhotos,
      meetingPointDisclosure: "PUBLIC",
      meetingPoint: nihoMeetingPoint(4),
      hosts: [host("Takuya")],
      provider: { ...NIHO_PROVIDER, logo: nihoLogo },
      seller: { displayName: "Panasonic Holdings Corporation", legalNoticeUrl: `${FIXTURE_NIHO_WEB_ORIGIN}/legal/tokushoho` },
      offers: [
        {
          id: "offer_coffee_roasting",
          name: "Roasting session",
          shortDescription: "About 75 minutes. Each guest roasts their own batch.",
          pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 4500, child: null },
          capacity: 3,
          maxPartySize: 3,
          minimumParticipants: 1,
          durationMinutes: 75,
          startTime: "14:00",
          weekdays: [0, 3, 5],
          cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 },
          acceptanceMode: "INSTANT",
          bookingQuestions: [PILOT_SOURCE_QUESTION],
          bookingQuestionsFingerprint: PILOT_QUESTION_FINGERPRINTS.source,
        },
      ],
      booking: bookingTerms(),
      updatedAt: PILOT_UPDATED_AT,
    },
    {
      slug: "engakuji-zen-meditation",
      title: "Zazen at Engakuji Temple, Kamakura",
      contentLanguage: "EN",
      region: { ...KAMAKURA },
      canonicalUrl: canonical("engakuji-zen-meditation"),
      lead:
        "Spend a quiet morning at Engakuji, one of Kamakura's great Zen temples. Walk the grounds with an English-speaking guide, talk with a Zen priest about what meditation is for, and then sit in zazen (seated meditation) together.",
      languageNote: "English, with an English-speaking guide",
      highlights: [
        "A private session for your group of 2 to 4",
        "Walk the grounds of Engakuji, founded in 1282, with an English-speaking guide",
        "Hear a Zen priest explain the purpose of zazen, and ask your own questions",
        "Try seated meditation, with a chair if sitting on the floor is difficult",
      ],
      timeline: [
        { time: "10:00", title: "Temple walk", text: "Explore the temple grounds and historic buildings with your guide.", photoIndex: 1 },
        { time: "10:30", title: "Talk with a Zen priest", text: "Learn what Zen is and why practitioners meditate. Ask anything you like.", photoIndex: 2 },
        { time: "11:00", title: "Meditation", text: "Practice zazen and other postures, guided by the priest.", photoIndex: 0 },
      ],
      description: [
        "Engakuji sits among wooded hills right next to Kita-Kamakura Station. Founded in 1282, it is one of Kamakura's major Zen temples and is still a place of Zen practice today.",
        "This private session begins with a walk through the temple grounds with an English-speaking guide. You then meet a Zen priest for a conversation about Zen and the reasons behind meditation, with time for your questions. Finally, the priest guides your group through zazen and other meditation postures. No experience is needed, and a chair can be provided if sitting on the floor is difficult.",
        "The session is private to your group, so it suits couples, friends and families who want an unhurried first encounter with Zen practice. It is arranged by Synk LLC, a Kamakura travel company, together with the temple.",
      ].join("\n\n"),
      included: [
        "Guided temple walk with an English-speaking guide",
        "Talk with a Zen priest and guided meditation",
        "Temple facility fees, interpretation and taxes",
      ],
      notIncluded: ["Transport to the temple"],
      notSuitableFor: ["Children under 12", "Guests who can't manage stairs and slopes (the temple grounds are hilly)"],
      knowBeforeYouGo: [
        "Please wear socks or stockings, as you will not walk barefoot.",
        "Wear loose, comfortable clothing and trousers or a skirt that cover your knees.",
        "Arriving more than 15 minutes late may mean the session cannot go ahead.",
        "Please book at least 2 days in advance.",
        "The temple walk goes ahead in light rain. If a heavy rain, storm or emergency warning is in effect for Kamakura three hours before the start, we cancel and offer a full refund or another date.",
        "Photography may be restricted in some halls. Your guide will tell you where you can take photos.",
      ],
      cover: zenPhotos[0] ?? null,
      photos: zenPhotos,
      meetingPointDisclosure: "PUBLIC",
      meetingPoint: {
        name: "Engakuji Temple",
        address: "409 Yamanouchi, Kamakura, Kanagawa 247-0062",
        accessNote: "1-minute walk from Kita-Kamakura Station.",
        entranceNote: "Your guide will confirm the exact meeting spot at the temple after booking.",
        mapUrl: "https://www.google.com/maps/search/?api=1&query=Engakuji%20Temple%20Kamakura",
        exteriorPhotoIndex: 3,
      },
      hosts: [],
      provider: {
        name: "Synk LLC",
        kind: "BUSINESS",
        tagline: "A Kamakura travel company that arranges this session with Engakuji Temple.",
        logo: null,
      },
      seller: { displayName: "Synk LLC", legalNoticeUrl: `${FIXTURE_NIHO_WEB_ORIGIN}/legal/tokushoho` },
      offers: [
        {
          id: "offer_engakuji_private",
          name: "Private session (2 to 4 guests)",
          shortDescription: "Your group only. About 90 minutes.",
          pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 62000, child: null },
          capacity: 4,
          maxPartySize: 4,
          minimumParticipants: 2,
          durationMinutes: 90,
          startTime: "10:00",
          weekdays: [2, 4, 6],
          cancellationPolicy: { code: "FREE_UNTIL_48H", freeCancellationHoursBefore: 48 },
          acceptanceMode: "APPROVAL",
          bookingQuestions: [PILOT_CHAIR_QUESTION],
          bookingQuestionsFingerprint: PILOT_QUESTION_FINGERPRINTS.chair,
        },
      ],
      booking: bookingTerms(),
      updatedAt: PILOT_UPDATED_AT,
    },
    {
      slug: "kamakura-ceramic-mending",
      title: "Kintsugi-Inspired Bowl Mending, Kamakura",
      contentLanguage: "EN",
      region: { ...KAMAKURA },
      canonicalUrl: canonical("kamakura-ceramic-mending"),
      lead:
        "Give a chipped cup or cracked bowl a second life. With Kamakura restorer Yukino, learn a modern, kintsugi-inspired way to repair ceramics using a clay-like adhesive, and finish a piece of your own.",
      languageNote: "Japanese & basic English",
      highlights: [
        "See how a restorer mends ceramics, and how this method differs from traditional lacquer kintsugi",
        "Repair a small piece of pottery yourself",
        "Choose the color of the repaired line",
        "A small group of up to 4 guests",
      ],
      timeline: [
        {
          time: "13:00",
          title: "Meet the work",
          text: "See mended pieces and the tools, and learn how this method differs from lacquer kintsugi.",
          photoIndex: 1,
        },
        { time: "13:20", title: "Mend your piece", text: "Fill and join the broken parts step by step with your host's help.", photoIndex: 0 },
        { time: "14:30", title: "Finish and wrap", text: "Add the colored finish and wrap your piece to take home.", photoIndex: 2 },
      ],
      description: [
        "Kintsugi, the art of mending broken pottery so that the repair becomes part of its beauty, traditionally uses urushi lacquer. Yukino, a restorer who works with NIHO in Kamakura, uses a different material: wglue®, a clay-like adhesive.",
        "In this small workshop at NIHO, a shared living room near Kamakura Station, Yukino shows you mended pieces and explains how the method works. You then repair a small piece of pottery yourself, filling and joining the broken parts step by step, and choose the color of the repaired line.",
        "This is not traditional lacquer kintsugi, but it is a hands-on way to experience the idea behind it: valuing everyday things enough to repair them.",
      ].join("\n\n"),
      included: ["A small piece of pottery to mend", "All materials and tools", "Wrapping to take your piece home"],
      notIncluded: ["Transport to and from NIHO"],
      notSuitableFor: ["Guests under 18", "Wheelchair users (the venue is on the second floor)"],
      knowBeforeYouGo: [
        "This workshop uses a modern adhesive, not traditional urushi lacquer.",
        "Whether a mended piece can be used for food and drink depends on the material. Your host will explain how to use it.",
        "Your piece may need time to set before use. Your host will explain how to take it home.",
        "Wear clothes you don't mind getting a little dirty.",
        "You'll wear slippers inside, as in a Japanese home.",
      ],
      cover: mendingPhotos[0] ?? null,
      photos: mendingPhotos,
      meetingPointDisclosure: "PUBLIC",
      meetingPoint: nihoMeetingPoint(3),
      hosts: [host("Yukino")],
      provider: {
        name: "YUKINO Restorer",
        kind: "INDIVIDUAL",
        tagline: "A Kamakura restorer who mends ceramics and other everyday things.",
        logo: null,
      },
      seller: { displayName: "YUKINO Restorer", legalNoticeUrl: `${FIXTURE_NIHO_WEB_ORIGIN}/legal/tokushoho` },
      offers: [
        {
          id: "offer_mending_workshop",
          name: "Mending workshop",
          shortDescription: "About two hours. All materials included.",
          pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 8800, child: null },
          capacity: 4,
          maxPartySize: 4,
          minimumParticipants: 1,
          durationMinutes: 120,
          startTime: "13:00",
          weekdays: [0, 6],
          cancellationPolicy: { code: "FREE_UNTIL_48H", freeCancellationHoursBefore: 48 },
          acceptanceMode: "APPROVAL",
          bookingQuestions: [],
          bookingQuestionsFingerprint: EMPTY_BOOKING_QUESTIONS_FINGERPRINT,
        },
      ],
      booking: bookingTerms(),
      updatedAt: PILOT_UPDATED_AT,
    },
    {
      slug: "kamakura-calligraphy",
      title: "Shodo: Japanese Calligraphy in Kamakura",
      contentLanguage: "EN",
      region: { ...KAMAKURA },
      canonicalUrl: canonical("kamakura-calligraphy"),
      lead:
        "Pick up a brush with calligrapher Shiryu, whose work was exhibited in New York in 2025. Learn the basic strokes, choose a word that means something to you, and write it on paper to take home.",
      languageNote: "Japanese & basic English",
      highlights: [
        "Learn how to hold the brush and write the basic strokes of shodo (Japanese calligraphy)",
        "Choose a word or kanji with your host and learn what it means",
        "Write a final piece to take home",
        "A small group of up to 6 guests",
      ],
      timeline: [
        { time: "15:30", title: "Brush basics", text: "Learn how to hold the brush, prepare the ink and write the basic strokes.", photoIndex: 1 },
        { time: "16:00", title: "Choose your word", text: "Pick a word or kanji with your host and practice it.", photoIndex: 0 },
        { time: "16:30", title: "Final piece", text: "Write your final piece and let it dry before you take it home.", photoIndex: 2 },
      ],
      description: [
        "Shodo, Japanese calligraphy, is about more than neat writing. Each stroke is made once, and the brush shows how you felt as you wrote.",
        "Shiryu is a calligrapher, MC and event producer who started shodo in 2017. In this small workshop at NIHO, a shared living room near Kamakura Station, Shiryu shows you how to hold the brush, prepare the ink and write the basic strokes. Together you choose a word or kanji that means something to you, practice it, and write a final piece to take home.",
        "No experience is needed. Children aged 8 and over are welcome with an adult.",
      ].join("\n\n"),
      included: ["Brush, ink and practice paper", "Paper for your final piece", "A folder to carry your work home"],
      notIncluded: ["Framing", "Transport to and from NIHO"],
      notSuitableFor: ["Children under 8", "Wheelchair users (the venue is on the second floor)"],
      knowBeforeYouGo: [
        "Ink can stain clothes. Aprons are provided.",
        "Your work needs a few minutes to dry before you carry it.",
        "You'll wear slippers inside, as in a Japanese home.",
        "Children aged 8 to 17 are welcome with an adult.",
      ],
      cover: calligraphyPhotos[0] ?? null,
      photos: calligraphyPhotos,
      meetingPointDisclosure: "PUBLIC",
      meetingPoint: nihoMeetingPoint(3),
      hosts: [host("Shiryu")],
      provider: {
        name: "Shiryu",
        kind: "INDIVIDUAL",
        tagline: "Calligrapher, MC and event producer. Exhibited in New York in 2025.",
        logo: null,
      },
      seller: { displayName: "Shiryu", legalNoticeUrl: `${FIXTURE_NIHO_WEB_ORIGIN}/legal/tokushoho` },
      offers: [
        {
          id: "offer_calligraphy_workshop",
          name: "Calligraphy workshop",
          shortDescription: "About 90 minutes. All materials included.",
          pricing: {
            currency: "JPY",
            taxIncluded: true,
            adultPriceYen: 6600,
            child: { priceYen: 4400, minAge: 8, maxAge: 17, adultRequired: true },
          },
          capacity: 6,
          maxPartySize: 6,
          minimumParticipants: 1,
          durationMinutes: 90,
          startTime: "15:30",
          weekdays: [0, 6],
          cancellationPolicy: { code: "FREE_UNTIL_48H", freeCancellationHoursBefore: 48 },
          acceptanceMode: "INSTANT",
          bookingQuestions: [],
          bookingQuestionsFingerprint: EMPTY_BOOKING_QUESTIONS_FINGERPRINT,
        },
      ],
      booking: bookingTerms(),
      updatedAt: PILOT_UPDATED_AT,
    },
  ];
}
