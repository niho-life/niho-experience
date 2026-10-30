// Mock data. Only the Community Dinner is a real listing; everything else is a placeholder.
const PH = (f) => `assets/photos/${f}.jpg`;

const EXPERIENCES = [
  { slug: "community-dinner", title: "Kamakura Community Dinner with Locals", with: "Takuya, Hasami & わか", face: "host-takuya",
    photo: "niho-cd-table-01", chip: "Up to 8 guests", dur: "2 hr", lang: "EN · JA", area: "station",
    lead: "Cook a seasonal home-style dinner together, then sit at one long table with the people who live here.",
    next: ["Thu 29", "Fri 30", "Sat 31"], price: "15,000", from: true },
  { slug: "morning-zazen", title: "Morning Zazen and a Quiet Temple Walk", with: "Shiryu", face: "host-shiryu",
    photo: "zazen-hall", chip: "Up to 6 guests", dur: "2.5 hr", lang: "EN", area: "kita",
    lead: "Sit for twenty minutes, then walk the back paths of Kita-Kamakura before the gates get busy.",
    next: ["Sat 31", "Sun 1", "Sat 7"], price: "9,800" },
  { slug: "calligraphy", title: "Write Your First Kanji at a Neighbor's Table", with: "Yukino", face: "host-yukino",
    photo: "calligraphy-brush", chip: "Up to 4 guests", dur: "1.5 hr", lang: "EN · JA", area: "hase",
    lead: "Grind the ink, learn three strokes, and take home a word you chose yourself.",
    next: ["Fri 30", "Mon 2", "Wed 4"], price: "7,500" },
  { slug: "kintsugi", title: "Mend a Plate with Kintsugi", with: "Kenji", face: "host-guide",
    photo: "kintsugi-plates", chip: "Up to 6 guests", dur: "3 hr", lang: "EN", area: "zaimokuza",
    lead: "Learn the slow, lacquer-and-gold way Kamakura homes repair what they love.",
    next: ["Sun 1", "Sun 8", "Sun 15"], price: "12,000" },
];

const TOPICS = [
  { id: "all", label: "All stories" },
  { id: "walks", label: "Walks & neighborhoods" },
  { id: "food", label: "Eat & drink" },
  { id: "seasons", label: "Seasons" },
  { id: "life", label: "Local life" },
  { id: "plans", label: "Day plans" },
];

const AREAS = [
  { id: "station", label: "Around the station", jp: "鎌倉駅・小町", photo: "niho-exterior",
    blurb: "Komachi-dori, the shrine approach and the backstreets where neighbors actually shop." },
  { id: "kita", label: "Kita-Kamakura", jp: "北鎌倉", photo: "temple-path",
    blurb: "Zen temples in the valleys, mossy steps and the quietest mornings in town." },
  { id: "hase", label: "Hase & the Buddha", jp: "長谷", photo: "daibutsu",
    blurb: "The Great Buddha, hillside temples and small cafés along the Enoden." },
  { id: "coast", label: "The coast", jp: "由比ヶ浜・七里ヶ浜", photo: "shichirigahama-fuji",
    blurb: "Long beaches, surf shops and Mt. Fuji at sunset on a clear day." },
  { id: "zaimokuza", label: "Zaimokuza & east", jp: "材木座・浄明寺", photo: "bamboo",
    blurb: "Bamboo groves, a fishing harbor and the slower side of the city." },
];

const ARTICLES = [
  { slug: "after-4pm", title: "Kamakura After 4 PM: What to Do When the Temples Close", topic: "plans", area: "station",
    photo: "kamakura-crossing", ex: "An evening route after your temple visits: the shrine at dusk, the coast, the Enoden, dinner and the train back to Tokyo.",
    date: "29 Oct", min: 4, real: true },
  { slug: "enoden-like-a-local", title: "Riding the Enoden Like You Live Here", topic: "walks", area: "hase",
    photo: "enoden-crossing", ex: "Which stops are worth getting off at, when the trains are quiet, and the crossing everyone photographs.",
    date: "27 Oct", min: 5 },
  { slug: "slow-morning-kita", title: "A Slow Morning in Kita-Kamakura", topic: "walks", area: "kita",
    photo: "temple-path", ex: "Three temples, one tea house and a back path over the hill. Start at 8 and you will have it nearly to yourself.",
    date: "24 Oct", min: 6 },
  { slug: "coffee-near-station", title: "Where Neighbors Get Coffee Near the Station", topic: "food", area: "station",
    photo: "coffee-pour", ex: "Five small roasters and kissaten within ten minutes of the West Exit, picked by people who walk past them daily.",
    date: "22 Oct", min: 4 },
  { slug: "shichirigahama-sunset", title: "Shichirigahama at Sunset, and How to Get Back", topic: "seasons", area: "coast",
    photo: "shichirigahama-fuji", ex: "When Fuji shows itself, where to sit on the seawall, and the last comfortable train home.",
    date: "20 Oct", min: 3 },
  { slug: "oden-season", title: "Oden Season: Winter Comfort Food in Kamakura", topic: "food", area: "station",
    photo: "dinner-oden", ex: "From the corner shop simmering since morning to the version we make at the community dinner.",
    date: "18 Oct", min: 4 },
  { slug: "bamboo-before-crowds", title: "The Bamboo Garden Before the Crowds", topic: "seasons", area: "zaimokuza",
    photo: "bamboo", ex: "Hōkokuji opens at nine. Here is how to be there first, and what to do after your matcha.",
    date: "15 Oct", min: 3 },
  { slug: "living-near-station", title: "What It's Like to Live Two Minutes from Kamakura Station", topic: "life", area: "station",
    photo: "niho-cd-kitchen-together", ex: "Garbage days, the morning market, neighbors' gardens and why nobody here owns a car.",
    date: "12 Oct", min: 7 },
  { slug: "rainy-day", title: "A Rainy Day in Kamakura: Six Plans That Still Work", topic: "plans", area: "hase",
    photo: "zen-garden-view", ex: "Temples are better in the rain. A route that keeps you mostly under a roof, with lunch in the middle.",
    date: "9 Oct", min: 5 },
  { slug: "great-buddha-no-rush", title: "The Great Buddha Without the Rush", topic: "walks", area: "hase",
    photo: "daibutsu", ex: "Arrive by the hiking trail, leave by the back streets of Hase, and skip the queue at the station.",
    date: "6 Oct", min: 4 },
  { slug: "repair-culture", title: "Mended, Not Replaced: Repair Culture in Kamakura Homes", topic: "life", area: "zaimokuza",
    photo: "kintsugi-plate", ex: "Kintsugi, darning and the hardware store that sharpens your knives while you wait.",
    date: "3 Oct", min: 6 },
  { slug: "one-day-kamakura", title: "One Day in Kamakura, Planned by Neighbors", topic: "plans", area: "station",
    photo: "dinner-long-table", ex: "Morning temple, lunch by the sea, an afternoon with a host and dinner at a long table.",
    date: "1 Oct", min: 8 },
];

const topicLabel = (id) => (TOPICS.find((t) => t.id === id) || {}).label || "";
const areaLabel = (id) => (AREAS.find((a) => a.id === id) || {}).label || "";

const ICONS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></symbol>
  <symbol id="i-chat" viewBox="0 0 24 24"><path d="M4.5 6.5c0-1.2 1-2 2.2-2h10.6c1.2 0 2.2.8 2.2 2v7c0 1.2-1 2-2.2 2H11l-4 3.5v-3.5h-.3c-1.2 0-2.2-.8-2.2-2z"/></symbol>
  <symbol id="i-cal" viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></symbol>
  <symbol id="i-people" viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.5" cy="8.5" r="2.6"/><path d="M15.5 13.2c2.5 0 4.4 1.6 5 4.6"/></symbol>
  <symbol id="i-pin" viewBox="0 0 24 24"><path d="M12 21s-6.5-6.1-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.9 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></symbol>
  <symbol id="i-book" viewBox="0 0 24 24"><path d="M4 5.5c2.8-.8 5.5-.5 8 1.2 2.5-1.7 5.2-2 8-1.2v13c-2.8-.8-5.5-.5-8 1.2-2.5-1.7-5.2-2-8-1.2z"/><path d="M12 6.7v13"/></symbol>
</svg>`;
document.body.insertAdjacentHTML("afterbegin", ICONS);

const ic = (id) => `<svg class="ico" aria-hidden="true"><use href="#i-${id}"/></svg>`;

function xcard(x, opts = {}) {
  return `<a class="xcard" href="#">
    <div class="xph">
      <img class="cov" src="${PH(x.photo)}" alt="" loading="lazy">
      <span class="chip">${x.chip}</span>
      <img class="face" src="${PH(x.face)}" alt="" loading="lazy">
    </div>
    <div class="xb">
      <div class="with">with ${x.with}</div>
      <h3>${x.title}</h3>
      ${opts.lead ? `<p class="lead" style="margin-top:6px;color:var(--ink2);font-size:15px">${x.lead}</p>` : ""}
      <div class="meta"><span>${ic("clock")}${x.dur}</span><span>${ic("chat")}${x.lang}</span></div>
      <div class="nextd">Next ${x.next.map((d) => `<i>${d}</i>`).join("")}</div>
      <div class="price">${x.from ? "From " : ""}<b>¥${x.price}</b> / adult</div>
    </div>
  </a>`;
}

function acard(a, opts = {}) {
  return `<a class="acard" href="#">
    <div class="aph"><img src="${PH(a.photo)}" alt="" loading="lazy"></div>
    <span class="cat">${opts.area ? areaLabel(a.area) : topicLabel(a.topic)}</span>
    <h3>${a.title}</h3>
    ${opts.noEx ? "" : `<p>${a.ex}</p>`}
    <div class="amet">${a.min} min read · ${a.date}</div>
  </a>`;
}

const PATTERNS = [
  { id: "a", href: "a-journal-grid.html", label: "A 雑誌グリッド" },
  { id: "b", href: "b-list-sidebar.html", label: "B リスト＋目次" },
  { id: "c", href: "c-neighborhoods.html", label: "C エリアで歩く" },
];

function chrome(current) {
  const bar = `<div class="mockbar"><div class="wrap"><span><b>トップページ案</b>（モック・写真と体験・記事は仮）</span>
    <nav aria-label="Mock patterns">${PATTERNS.map((p) => `<a href="${p.href}"${p.id === current ? ' aria-current="page"' : ""}>${p.label}</a>`).join("")}<a href="index.html">一覧</a></nav></div></div>`;
  const header = `<header class="hd"><div class="wrap">
    <a class="logo" href="#"><img src="assets/icon.svg" alt="">NIHO <span>Experience</span></a>
    <nav aria-label="Main"><a href="#experiences">Experiences</a><a href="#stories">Stories</a><a class="d" href="#">Host with NIHO</a><a class="d" href="#">Help</a><span class="lang">EN · ¥</span><button class="menu" type="button" aria-label="Menu"><svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button></nav>
  </div></header>`;
  document.getElementById("top").innerHTML = bar + header;
  document.getElementById("foot").innerHTML = `<footer class="ft"><div class="wrap">
    <div class="cols">
      <div class="brand"><a class="logo" href="#"><img src="assets/icon.svg" alt="">NIHO <span>Experience</span></a>
        <p>Small experiences and local notes for enjoying Kamakura's streets and everyday life, from people who live here.</p></div>
      <div><h4>Experiences</h4><ul><li><a href="#">All experiences</a></li><li><a href="#">Food & dinners</a></li><li><a href="#">Crafts</a></li><li><a href="#">Temples & zen</a></li></ul></div>
      <div><h4>Stories</h4><ul>${TOPICS.slice(1).map((t) => `<li><a href="#">${t.label}</a></li>`).join("")}</ul></div>
      <div><h4>NIHO</h4><ul><li><a href="#">Host with NIHO</a></li><li><a href="#">Help & booking</a></li><li><a href="#">Cancellation policy</a></li><li><a href="#">Terms & privacy</a></li></ul></div>
    </div>
    <p class="note">Mock for layout review · hosts other than the community dinner, dates, prices, photos and stories are placeholders · nothing can be booked</p>
  </div></footer>`;
}
