"use strict";
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  throw new Error("framed");
}
/* ============================================================
   CONFIG — edit these
   ============================================================ */
const CONFIG = {
  REFRESH_MS: 5 * 60 * 1000,
  DWELL_MS: 17000,
  HOLD_MS: 45000,           // how long a story you clicked into stays up
  VOLUME: 0.55,
  MAX_AGE_DAYS: 10,
};

// Public-domain Musopen recordings, stored under audio/.
const TRACKS = [
  { file: "bach-partita-3-preludio.ogg", title: "Partita No. 3 in E major, I. Preludio", by: "J. S. Bach" },
  { file: "chopin-mazurka-17-4.ogg",                       title: "Mazurka No. 4 in A minor, Op. 17",      by: "Frédéric Chopin" },
  { file: "glazunov-chant-du-menestrel.ogg",                          title: "Chant du ménestrel, Op. 71",            by: "Alexander Glazunov" },
  { file: "saint-saens-cello-concerto-1-iii.ogg", title: "Cello Concerto No. 1, III. Tempo primo", by: "Camille Saint-Saëns" },
  { file: "beethoven-pastoral-iii.ogg", title: "Symphony No. 6 ‘Pastoral’, III. Allegro", by: "Ludwig van Beethoven" },
  { file: "satie-gymnopedie-1.ogg",                  title: "Gymnopédie No. 1",                      by: "Erik Satie" },
];
const trackUrl = (f) => "audio/" + f;

/* ============================================================
   Helpers
   ============================================================ */
const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const ICONS = {
  cyber: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 4.5 5.5v6c0 5 3.2 8.2 7.5 10 4.3-1.8 7.5-5 7.5-10v-6L12 2.5Z"/><path d="M9 11.5h6M12 8.5v6"/></svg>',
  geo:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 4.2 5.6 4.2 9s-1.4 6.4-4.2 9c-2.8-2.6-4.2-5.6-4.2-9S9.200 5.600 12 3Z"/></svg>',
  note:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="17.500" cy="16" r="2.500"/></svg>',
};
$("npico").innerHTML = ICONS.note;   // static strings only; feed data is only ever set via textContent

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
  const d = Math.round(h / 24);
  return d + (d === 1 ? " day ago" : " days ago");
}
function agoShort(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d";
}
/* ============================================================
   News
   ============================================================ */
const news = { all: [], queue: [], idx: -1, filter: "all", topic: null, hover: false, cur: null, df: new Map(), lastOk: 0, generated: 0, timer: 0, busy: false };

async function fetchNews() {
  const bucket = Math.floor(Date.now() / CONFIG.REFRESH_MS);
  const r = await fetch("news.json?v=" + bucket, { signal: AbortSignal.timeout(12000), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!r.ok) throw new Error("news " + r.status);
  const j = await r.json();
  const generated = Date.parse(j.generated);
  if (Number.isFinite(generated)) news.generated = generated;
  return (j.items || []).filter((x) => x && typeof x.title === "string" && typeof x.source === "string" && (x.cat === "cyber" || x.cat === "geo") && Number.isFinite(x.ts)).map((x) => ({
    source: x.source.slice(0, 80),
    cat: x.cat,
    title: x.title.slice(0, 220),
    summary: typeof x.summary === "string" ? x.summary.slice(0, 320) : "",
    ts: x.ts,
  }));
}

async function refreshNews() {
  if (news.busy) return;
  news.busy = true;
  try {
    const cutoff = Date.now() - CONFIG.MAX_AGE_DAYS * 864e5;
    const items = (await fetchNews()).filter((x) => x.ts >= cutoff).sort((a, b) => b.ts - a.ts);
    if (items.length) { news.all = items; analyse(); news.lastOk = Date.now(); rebuildQueue(false); }
  } catch { /* keep showing the last good set */ }
  news.busy = false;
  paintStatus();
}

function rebuildQueue(reset) {
  const cur = news.queue[news.idx];
  let pool = news.all.filter((x) => news.filter === "all" || x.cat === news.filter);
  if (news.topic) {
    const f = pool.filter((x) => hasTopic(x, news.topic.key));
    if (f.length) pool = f; else { news.topic = null; paintLens(); }   // lens ran dry after a refresh
  }
  let q;
  if (news.filter === "all" && !news.topic) {   // interleave cyber and world so the feed never feels one-note
    const c = pool.filter((x) => x.cat === "cyber"), g = pool.filter((x) => x.cat !== "cyber");
    q = [];
    for (let i = 0; i < Math.max(c.length, g.length) && q.length < 60; i++) { if (c[i]) q.push(c[i]); if (g[i]) q.push(g[i]); }
  } else q = pool.slice(0, 60);
  news.queue = q;
  news.idx = reset || !cur ? -1 : Math.max(-1, q.findIndex((x) => x.title === cur.title));
  buildTicker();
  if (news.idx === -1 && reset) showNext(1);
  else if (!cur && q.length) showNext(1);
}

function buildTicker() {
  const t = $("track");
  t.textContent = "";
  if (!news.queue.length) return;
  const frag = document.createDocumentFragment();
  for (let pass = 0; pass < 2; pass++) {
    for (const it of news.queue) {
      const s = document.createElement("span");
      s.className = "tick " + (it.cat === "cyber" ? "cyber" : "geo");
      const e = document.createElement("em"); e.textContent = it.source;
      const x = document.createElement("span"); x.textContent = it.title;
      s.append(e, x);
      frag.append(s);
    }
  }
  t.append(frag);
  requestAnimationFrame(() => { t.style.setProperty("--dur", Math.max(60, Math.round(t.scrollWidth / 2 / 55)) + "s"); });
}

let dwellStart = 0, dwellLen = CONFIG.DWELL_MS, renderTok = 0;
function show(it, hold) {
  const tok = ++renderTok, story = $("story"), side = $("side");
  clearTimeout(news.timer);
  story.classList.add("out"); side.classList.add("out");
  setTimeout(() => {
    if (tok !== renderTok) return;                     // a newer click or step superseded this one
    news.cur = it;
    story.dataset.cat = it.cat === "cyber" ? "cyber" : "geo";
    $("ico").innerHTML = it.cat === "cyber" ? ICONS.cyber : ICONS.geo;
    $("cat").textContent = it.cat === "cyber" ? "Cyber" : "World";
    $("src").textContent = it.source;
    $("age").textContent = ago(it.ts);
    $("ttl").textContent = it.title;
    $("sum").textContent = it.summary && it.summary.toLowerCase() !== it.title.toLowerCase() ? it.summary : "";
    buildGraph(it);
    story.classList.remove("out"); side.classList.remove("out");
    dwellStart = performance.now();
    schedule(hold ? CONFIG.HOLD_MS : CONFIG.DWELL_MS);
  }, 900);
}
function showNext(dir) {
  const n = news.queue.length;
  if (!n) { schedule(CONFIG.DWELL_MS); return; }
  news.idx = (news.idx + dir + n) % n;
  show(news.queue[news.idx], false);
}
function jumpTo(it) {                                  // open any story, even one outside the current queue
  let i = news.queue.findIndex((x) => x.title === it.title);
  if (i < 0) { news.queue.splice(news.idx + 1, 0, it); i = news.idx + 1; }
  news.idx = i; show(it, true);
}
function schedule(ms) { clearTimeout(news.timer); dwellLen = ms; news.timer = setTimeout(tickNext, ms); }
function tickNext() { if (news.hover) { news.timer = setTimeout(tickNext, 4000); return; } showNext(1); }   // don't yank a story away while the pointer is exploring

function toggleLens(tp) {
  const cur = news.cur;
  news.topic = news.topic && news.topic.key === tp.key ? null : { key: tp.key, label: tp.label };
  rebuildQueue(false); paintLens();
  if (news.topic) {                                    // jump to the freshest story on this topic that isn't the one already showing
    const i = news.queue.findIndex((x) => !cur || x.title !== cur.title);
    if (i >= 0) { news.idx = i; show(news.queue[i], true); }
  } else if (cur) buildGraph(cur);
}
function paintLens() {
  const b = $("lens");
  b.hidden = !news.topic;
  if (news.topic) b.textContent = "Following · " + news.topic.label + "  ✕";
}

/* ============================================================
   Related topics — lexicon + ID patterns, scored by rarity (idf)
   Extend LEX freely: [label, regex]. Matching runs on title + summary.
   ============================================================ */
const LEX = [
  ["Ransomware", /ransomware|extortion (?:gang|group)/i],
  ["Phishing", /phish|smishing|vishing|social engineering/i],
  ["Zero-day", /zero[- ]days?/i],
  ["Data breach", /data (?:breach|leak|theft)|breach(?:ed|es)?\b|leaked data|stolen data/i],
  ["DDoS", /\bDDoS\b|denial[- ]of[- ]service/i],
  ["Botnet", /botnet/i],
  ["Malware", /malware|trojan|spyware|infostealer|info-stealer|backdoor|\bwiper\b/i],
  ["Supply chain", /supply[- ]chain|\bnpm\b|\bpypi\b|typosquat|malicious packages?/i],
  ["Vulnerability", /vulnerabilit|\bflaws?\b|\bbugs?\b|\bCVE-\d/i],
  ["Exploitation", /exploit|\bKEV\b/i],
  ["Patching", /\bpatch(?:es|ed|ing)?\b|security updates?/i],
  ["Espionage", /espionage|\bspying\b|\bspies\b|cyber[- ]?spy/i],
  ["Nation-state", /nation[- ]state|state[- ]sponsored|state[- ]backed|\bAPT\d*\b/i],
  ["Cyberattack", /cyber[- ]?attack/i],
  ["Credentials", /credential|password|passkey|\bMFA\b|multi[- ]factor|two[- ]factor|account takeover/i],
  ["Cloud", /\bcloud\b|\bSaaS\b|\bAzure\b|\bAWS\b/i],
  ["AI", /\bAI\b|\b[Aa]rtificial [Ii]ntelligence\b|\bLLMs?\b|\b[Cc]hatbots?\b|\b[Gg]enerative\b|\b[Aa]gentic\b|\bMCP\b/],
  ["Deepfakes", /deepfake|voice clon/i],
  ["Crypto", /crypto|bitcoin|ethereum|blockchain|stablecoin/i],
  ["Critical infrastructure", /critical infrastructure|\bSCADA\b|power grid|water (?:utility|utilities|system)|\bICS\b/i],
  ["Healthcare", /hospital|healthcare|health (?:system|provider|service)|\bpatients?\b/i],
  ["Law enforcement", /\barrest|indict|extradit|sentenced|Europol|Interpol|\bFBI\b|takedown|seized|charged with/i],
  ["Privacy", /privacy|GDPR|surveillance|facial recognition/i],
  ["Regulation", /regulat|legislation|\bcompliance\b|\bfined?\b|\bfines\b/i],
  ["Microsoft", /Microsoft|\bWindows\b|\bEntra\b|SharePoint|\bExchange Server\b|Copilot|\bOutlook\b/],
  ["Google", /Google|Chrome|Gmail|Gemini|Android|Mandiant/],
  ["Apple", /\bApple\b|iPhone|\biOS\b|macOS|\biPad\b/],
  ["Cisco", /\bCisco\b/],
  ["Fortinet", /Forti(?:net|Gate|OS|Web|SIEM|Manager)/],
  ["Palo Alto", /Palo Alto|PAN-OS|Unit 42/],
  ["Ivanti", /\bIvanti\b/], ["Citrix", /\bCitrix\b|NetScaler/], ["VMware", /VMware|\bESXi\b/],
  ["CrowdStrike", /CrowdStrike|\bFalcon\b/],
  ["Okta", /\bOkta\b/], ["Cloudflare", /Cloudflare/], ["Amazon", /\bAmazon\b|\bAWS\b/],
  ["Oracle", /\bOracle\b/], ["Salesforce", /Salesforce/], ["GitHub", /GitHub/], ["Linux", /\bLinux\b/],
  ["Meta", /\bMeta\b|Facebook|Instagram|WhatsApp/],
  ["OpenAI", /OpenAI|ChatGPT/], ["Anthropic", /Anthropic|\bClaude\b/], ["Nvidia", /Nvidia/i], ["Telegram", /Telegram/],
  ["China", /China|Chinese|Beijing|\bPRC\b/],
  ["Russia", /Russia|Moscow|Kremlin|Putin/],
  ["Ukraine", /Ukrain|Kyiv|Kiev|Zelensk/],
  ["Iran", /\bIran|Tehran/],
  ["Israel", /Israel|Netanyahu|\bIDF\b|Tel Aviv/],
  ["Gaza", /Gaza|Hamas|Palestin|West Bank/],
  ["Lebanon", /Lebanon|Hezbollah|Beirut/],
  ["Middle East", /Middle East|Syria|Yemen|Houthi|Iraq|Saudi|\bGulf\b/],
  ["North Korea", /North Korea|DPRK|Pyongyang/],
  ["South Korea", /South Korea|Seoul/],
  ["Taiwan", /Taiwan|Taipei/], ["Japan", /Japan|Tokyo/], ["India", /\bIndia|\bDelhi\b|\bModi\b/], ["Pakistan", /Pakistan/],
  ["United States", /\bU\.S\.|\bUS\b|\bUSA\b|United States|Washington|Pentagon|White House|Congress/],
  ["Trump", /Trump/],
  ["United Kingdom", /\bUK\b|\bU\.K\.|Britain|British|London|Starmer/],
  ["Europe", /\bEU\b|European|Europe|Brussels/],
  ["Germany", /German/], ["France", /France|French|Paris|Macron/],
  ["Australia", /Australia|Canberra|Sydney|Melbourne|\bASD\b|\bACSC\b/],
  ["New Zealand", /New Zealand|\bNZ\b|Aotearoa|Auckland|Wellington|Luxon/],
  ["Pacific", /Pacific|\bFiji\b|Samoa|Tonga|Solomon Islands|Vanuatu|Papua New Guinea/],
  ["Africa", /Africa|Sudan|Nigeria|Kenya|Ethiopia|Congo/],
  ["Latin America", /Latin America|Venezuela|Mexico|Brazil|Argentina|Colombia/],
  ["Canada", /Canad/], ["Turkey", /Turkey|Türkiye|Erdo[gğ]an/],
  ["NATO", /\bNATO\b/], ["United Nations", /United Nations|\bUN\b|Security Council/],
  ["Sanctions", /sanction/i],
  ["Trade", /tariff|trade (?:war|deal|talks)|export controls?/i],
  ["Energy", /\boil\b|\bLNG\b|\bOPEC\b|\benergy\b|nuclear power/i],
  ["Military", /military|\btroops?\b|missile|\bdrones?\b|warship|airstrike|\bnavy\b|\barmy\b|defen[cs]e|\bwar\b/i],
  ["Nuclear", /nuclear|uranium|enrichment/i],
  ["Peace talks", /ceasefire|\btruce\b|peace (?:talks|deal|plan)|negotiat/i],
  ["Elections", /election|ballot|\bvoters?\b|referendum/i],
  ["Protests", /protest|demonstrat/i],
  ["Disasters", /earthquake|wildfire|\bflood|cyclone|hurricane|tsunami|volcan/i],
  ["Migration", /migrant|refugee|asylum/i],
  ["Economy", /inflation|recession|interest rates?|central bank|\beconom/i],
  ["Semiconductors", /semiconductor|\bchips?\b|chipmaker|TSMC/i],
];
const ACTORS = ["Lazarus", "Kimsuky", "Sandworm", "Turla", "Volt Typhoon", "Salt Typhoon", "Scattered Spider", "LockBit", "Cl0p", "Akira", "Qilin", "ShinyHunters", "Black Basta", "BlackCat", "ALPHV", "Rhysida"];
const ACTOR_MAP = Object.fromEntries(ACTORS.map((n) => [n.toLowerCase(), n]));
const ACTOR_RE = new RegExp("\\b(" + ACTORS.join("|") + ")\\b", "gi");
const ID_RE = /\b(?:CVE-\d{4}-\d{4,7}|APT\d{1,3}|FIN\d{1,2}|UNC\d{3,4}|Storm-\d{3,4})\b/gi;

function termsOf(it) {
  const s = it.title + " . " + (it.summary || "");
  const out = new Set();
  for (const [label, re] of LEX) if (re.test(s)) out.add(label);
  for (const m of s.matchAll(ACTOR_RE)) out.add(ACTOR_MAP[m[1].toLowerCase()]);
  for (const m of s.matchAll(ID_RE)) out.add(/^storm/i.test(m[0]) ? "Storm-" + m[0].slice(6) : m[0].toUpperCase());
  return out;
}
function analyse() {
  const df = new Map();
  for (const x of news.all) { x.terms = termsOf(x); for (const t of x.terms) df.set(t, (df.get(t) || 0) + 1); }
  news.df = df;
}
const idf = (c) => Math.log(1 + Math.max(1, news.all.length) / Math.max(1, c));
const hasTopic = (x, key) => key.startsWith("src:") ? x.source === key.slice(4) : !!(x.terms && x.terms.has(key));

/* Every topic belongs to one of four lenses. Ranking favours ties that bridge them
   (e.g. an exploit story <-> a geopolitics story), so the graph suggests the "why it matters". */
const DOMAIN = {};
[["security", "Ransomware,Phishing,Zero-day,Data breach,DDoS,Botnet,Malware,Supply chain,Vulnerability,Exploitation,Patching,Espionage,Nation-state,Cyberattack,Credentials"],
 ["digital", "Cloud,AI,Deepfakes,Crypto,Privacy,Semiconductors,Microsoft,Google,Apple,Cisco,Fortinet,Palo Alto,Ivanti,Citrix,VMware,CrowdStrike,Okta,Cloudflare,Amazon,Oracle,Salesforce,GitHub,Linux,Meta,OpenAI,Anthropic,Nvidia,Telegram"],
 ["safety", "Critical infrastructure,Healthcare,Law enforcement,Disasters,Migration,Nuclear,Energy"],
 ["politics", "China,Russia,Ukraine,Iran,Israel,Gaza,Lebanon,Middle East,North Korea,South Korea,Taiwan,Japan,India,Pakistan,United States,Trump,United Kingdom,Europe,Germany,France,Australia,New Zealand,Pacific,Africa,Latin America,Canada,Turkey,NATO,United Nations,Sanctions,Trade,Military,Peace talks,Elections,Protests,Economy,Regulation"],
].forEach(([d, s]) => s.split(",").forEach((l) => (DOMAIN[l] = d)));
const domOf = (t) => DOMAIN[t] || "security";            // actor names and CVE/APT ids are security by nature
const DOM_NAME = { security: "Security", digital: "Digital", safety: "Safety", politics: "Politics" };
const DOMW = { security: 1.25, safety: 1.15, politics: 1.15, digital: 1 };

function relate(it, maxStories) {
  it.terms = it.terms || termsOf(it);
  const others = news.all.filter((x) => x.title !== it.title);
  const cnt = new Map(), crs = new Map();
  for (const x of others) for (const t of it.terms) if (x.terms && x.terms.has(t)) {
    cnt.set(t, (cnt.get(t) || 0) + 1);
    if (x.cat !== it.cat) crs.set(t, (crs.get(t) || 0) + 1);   // topic also appears on the other side (cyber <-> world)
  }
  const cap = Math.max(6, others.length * 0.4);                // skip topics so common they link everything to everything
  const pool = [...cnt].filter(([, c]) => c <= cap).map(([t, c]) => {
    const dom = domOf(t), bridge = 1 + 0.5 * ((crs.get(t) || 0) / c);
    return { key: t, label: t, dom, count: c + 1, w: idf(c + 1), rank: idf(c + 1) * (1 + Math.log(c)) * DOMW[dom] * bridge };
  });
  const topics = [], seen = {};
  while (topics.length < 5 && pool.length) {                   // greedy pick, softly penalising a lens that's already represented
    pool.forEach((q) => { q.adj = q.rank * Math.pow(0.72, seen[q.dom] || 0); });
    pool.sort((a, b) => b.adj - a.adj);
    const q = pool.shift(); topics.push(q); seen[q.dom] = (seen[q.dom] || 0) + 1;
  }
  if (topics.length < 2)                                       // thin story: fall back to "more from this source"
    topics.push({ key: "src:" + it.source, label: it.source, dom: "src", count: others.filter((x) => x.source === it.source).length + 1, w: 0.6, rank: 0 });
  const scored = [];
  for (const x of others) {
    let s = 0; const via = [];
    topics.forEach((tp, i) => {
      const ok = tp.dom === "src" ? x.source === it.source && x.terms && x.terms.size : hasTopic(x, tp.key);   // never suggest off-lens stories
      if (ok) { s += tp.w; via.push(i); }
    });
    if (!via.length) continue;
    s += 0.35 * (new Set(via.map((i) => topics[i].dom)).size - 1);   // reward ties that span lenses
    if (x.cat !== it.cat) s += 0.6;                                  // reward cyber <-> world ties
    s += 0.5 * Math.exp(-(Date.now() - x.ts) / 36e5 / 36);           // gentle recency nudge
    scored.push({ x, s, via });
  }
  scored.sort((a, b) => b.s - a.s);
  return { topics, stories: scored.slice(0, maxStories) };
}

/* ============================================================
   Graph rendering (plain SVG, no libraries; feed text only via textContent)
   ============================================================ */
const G = { nodes: [], edges: [], hot: null };
const SVGNS = "http://www.w3.org/2000/svg";
function el(name, attrs, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
}
function wrap(str, max, lines) {
  const words = str.split(/\s+/), out = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i], t = cur ? cur + " " + w : w;
    if (t.length <= max || !cur) { cur = t; continue; }
    out.push(cur);
    if (out.length === lines - 1) { cur = words.slice(i).join(" "); break; }
    cur = w;
  }
  if (cur) out.push(cur);
  const l = out.length - 1;
  if (out[l].length > max) out[l] = out[l].slice(0, max - 1).trimEnd() + "…";
  return out;
}
const ORB = { security: "teal", digital: "blue", safety: "violet", politics: "pink", src: "mist", cyber: "teal", geo: "pink" };
function orbDefs(svg) {
  const d = el("defs", {}, svg);
  const cols = { teal: "var(--teal)", blue: "var(--blue)", violet: "var(--violet)", pink: "var(--pink)", mist: "var(--ink-faint)", white: "#ffffff" };
  for (const k in cols) {
    const g = el("radialGradient", { id: "og-" + k }, d);
    [[0, 0.85], [0.28, 0.4], [0.62, 0.12], [1, 0]].forEach(([o, a]) => el("stop", { offset: o, "stop-color": cols[k], "stop-opacity": a }, g));
  }
}
function orb(parent, color, R, coreR) {                  // a soft glowing orb: wide gradient bloom + a tiny bright core
  const g = el("g", { class: "pulse" }, parent);
  el("circle", { r: R, fill: "url(#og-" + color + ")" }, g);
  el("circle", { r: coreR * 3.2, fill: "url(#og-white)", opacity: 0.55 }, g);
  el("circle", { r: coreR, fill: "#fff", opacity: 0.95 }, g);
  return g;
}

function buildGraph(it) {
  const svg = $("graph");
  svg.textContent = ""; G.nodes = []; G.edges = []; G.hot = null; hideTip();
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!it || W < 220 || H < 220) return;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  orbDefs(svg);

  const rel = relate(it, H < 420 ? 5 : 7);
  const cx = W / 2, cy = H / 2;
  const labW = Math.min(170, W * 0.22);
  const rxS = Math.max(90, W / 2 - labW - 10), ryS = Math.max(90, H / 2 - 96);
  const rxT = rxS * 0.58, ryT = ryS * 0.56;

  el("ellipse", { class: "guide", cx, cy, rx: rxT, ry: ryT }, svg);
  el("ellipse", { class: "guide", cx, cy, rx: rxS, ry: ryS }, svg);
  const eL = el("g", {}, svg), nL = el("g", {}, svg);
  const mk = (kind, cls, x, y, amp, i) => {
    const g = el("g", { class: "node " + kind + (cls ? " " + cls : ""), "data-n": G.nodes.length }, nL);
    const inner = el("g", { class: "pop" }, g); inner.style.setProperty("--i", String(i));
    const n = { kind, x, y, cx: x, cy: y, amp, hs: 1, p1: Math.random() * 6.28, p2: Math.random() * 6.28, s1: 0.32 + Math.random() * 0.3, s2: 0.26 + Math.random() * 0.3, g, inner, pu: null, edges: [] };
    G.nodes.push(n); return n;
  };
  const link = (a, b, cls) => {
    const l = el("path", { class: "edge " + cls }, eL);
    const e = { l, a, b, bend: (Math.random() - 0.5) * 0.34, ph: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.25 };
    G.edges.push(e); a.edges.push(e); b.edges.push(e);
  };
  const catKey = it.cat === "cyber" ? "cyber" : "geo";

  // centre = the story on screen
  const core = mk("core", catKey, cx, cy, 1.5, 0);
  el("circle", { class: "ripple", r: 30 }, core.inner);
  el("circle", { class: "ripple late", r: 30 }, core.inner);
  core.pu = orb(core.inner, ORB[catKey], 74, 6);

  // inner ring = topics (coloured by lens)
  const nt = rel.topics.length, tAng = [];
  rel.topics.forEach((tp, i) => {
    const a = -Math.PI / 2 + Math.PI / nt + (i * 2 * Math.PI) / nt;
    tAng.push(a);
    const n = mk("topic", "d-" + tp.dom + (news.topic && news.topic.key === tp.key ? " on" : ""), cx + rxT * Math.cos(a), cy + ryT * Math.sin(a), 6, i + 1);
    n.topic = tp;
    const R = 30 + Math.min(tp.count, 8) * 2.6;
    n.pu = orb(n.inner, ORB[tp.dom], R, 3.6);
    el("circle", { class: "selring", r: R * 0.5 }, n.inner);
    const t = el("text", { class: "t-topic", "text-anchor": "middle", y: 27 }, n.inner);
    const lab = tp.label.length > 18 ? tp.label.slice(0, 17) + "…" : tp.label;
    t.append(document.createTextNode(lab + " "));
    el("tspan", { class: "c" }, t).textContent = tp.count;
    el("circle", { class: "hit", r: 28 }, n.inner);
    link(core, n, "core e-" + tp.dom);
  });

  // outer ring = related stories, placed near the topics they share
  const ns = rel.stories.length;
  if (ns) {
    const des = rel.stories.map((s) => { let sx = 0, sy = 0; s.via.forEach((i) => { sx += Math.cos(tAng[i]); sy += Math.sin(tAng[i]); }); return Math.atan2(sy, sx); });
    const order = des.map((_, i) => i).sort((i, j) => des[i] - des[j]);
    const step = (2 * Math.PI) / ns;
    let best = null;
    for (let off = 0; off < 12; off++) {
      const base = -Math.PI + (off * step) / 12;
      for (let rot = 0; rot < ns; rot++) {
        let cost = 0; const asg = [];
        order.forEach((si, k) => {
          const a = base + ((k + rot) % ns) * step;
          const d = Math.atan2(Math.sin(a - des[si]), Math.cos(a - des[si]));
          cost += d * d; asg[si] = a;
        });
        if (!best || cost < best.cost) best = { cost, asg };
      }
    }
    rel.stories.forEach((s, i) => {
      const a = best.asg[i], co = Math.cos(a), si = Math.sin(a), x = s.x;
      const n = mk("story", x.cat === "cyber" ? "cyber" : "geo", cx + rxS * co, cy + ryS * si, 8, nt + 1 + i);
      n.item = x; n.ties = s.via.map((k) => rel.topics[k]);
      const nx = cx + rxS * co;
      let anchor = "middle", lx = 0, avail;
      if (co > 0.38) { anchor = "start"; lx = 18; avail = W - nx - 18 - 10; }
      else if (co < -0.38) { anchor = "end"; lx = -18; avail = nx - 18 - 10; }
      else avail = Math.min(230, Math.min(nx, W - nx) * 2 - 20);
      const maxCh = Math.max(12, Math.min(28, Math.floor(avail / 7.3)));
      const lines = wrap(x.title, maxCh, 3), L = lines.length + 1;
      const ly = anchor !== "middle" ? -3 : si > 0 ? 32 : -16 - (L - 1) * 17;
      n.pu = orb(n.inner, ORB[x.cat === "cyber" ? "cyber" : "geo"], 28, 3.4);
      const t = el("text", { class: "t-title", "text-anchor": anchor, x: lx, y: ly }, n.inner);
      lines.forEach((ln, k) => { const ts = el("tspan", { x: lx, dy: k ? 17 : 0 }, t); ts.textContent = ln; });
      const m = el("text", { class: "t-meta", "text-anchor": anchor, x: lx, y: ly + lines.length * 17 + 1 }, n.inner);
      const age = agoShort(x.ts), room = Math.max(8, Math.floor(avail / 7.9) - age.length - 3);
      m.textContent = (x.source.length > room ? x.source.slice(0, room - 1) + "…" : x.source) + " · " + age;
      el("circle", { class: "hit", r: 24 }, n.inner);
      s.via.forEach((ti) => link(n, G.nodes[1 + ti], "e-" + rel.topics[ti].dom));
    });
  }
  tickGraph();
}

function tickGraph() {                                   // slow drift, breathing orbs, curved hairlines; called from the main loop
  if (!G.nodes.length) return;
  for (const n of G.nodes) {
    if (!reduce) { n.cx = n.x + Math.sin(T * n.s1 + n.p1) * n.amp; n.cy = n.y + Math.cos(T * n.s2 + n.p2) * n.amp; }
    n.hs += ((n === G.hot ? 1.3 : 1) - n.hs) * 0.12;     // ease toward the hover size
    n.g.setAttribute("transform", "translate(" + n.cx.toFixed(1) + " " + n.cy.toFixed(1) + ")");
    if (n.pu) n.pu.setAttribute("transform", "scale(" + ((reduce ? 1 : 1 + 0.07 * Math.sin(T * 0.8 + n.p1)) * n.hs).toFixed(3) + ")");
  }
  for (const e of G.edges) {
    const x1 = e.a.cx, y1 = e.a.cy, x2 = e.b.cx, y2 = e.b.cy, dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const bend = (e.bend + (reduce ? 0 : Math.sin(T * e.sp + e.ph) * 0.09)) * len;
    const qx = (x1 + x2) / 2 - (dy / len) * bend, qy = (y1 + y2) / 2 + (dx / len) * bend;
    e.l.setAttribute("d", "M" + x1.toFixed(1) + " " + y1.toFixed(1) + " Q" + qx.toFixed(1) + " " + qy.toFixed(1) + " " + x2.toFixed(1) + " " + y2.toFixed(1));
  }
}

/* ---- graph interaction ---- */
const tip = $("tip");
function nodeOf(t) { const g = t.closest && t.closest(".node"); return g ? G.nodes[+g.dataset.n] : null; }
function setHot(n) {
  if (G.hot === n) return;
  if (G.hot) { G.hot.g.classList.remove("hot"); G.hot.edges.forEach((e) => e.l.classList.remove("hot")); }
  G.hot = n;
  if (n) { n.g.classList.add("hot"); n.edges.forEach((e) => e.l.classList.add("hot")); }
}
function showTip(n, ev) {
  tip.textContent = "";
  const b = document.createElement("b"), s = document.createElement("span");
  if (n.kind === "story") {
    b.textContent = n.item.title;
    s.textContent = n.item.source + " · " + (n.item.cat === "cyber" ? "Cyber" : "World") + " · " + ago(n.item.ts);
    tip.append(b, s);
    const doms = [...new Set(n.ties.map((t) => DOM_NAME[t.dom]).filter(Boolean))];
    const t2 = document.createElement("span"); t2.className = "tie";
    t2.textContent = (doms.length > 1 ? doms.join(" × ") + " — " : "") + "via " + n.ties.map((t) => t.label).join(", ");
    tip.append(t2);
  } else {
    b.textContent = n.topic.key.startsWith("src:") ? "More from " + n.topic.label : n.topic.label;
    s.textContent = (DOM_NAME[n.topic.dom] ? DOM_NAME[n.topic.dom] + " · " : "") + n.topic.count + " stories · click to " + (news.topic && news.topic.key === n.topic.key ? "stop following" : "follow this topic");
    tip.append(b, s);
  }
  tip.classList.add("show"); moveTip(ev);
}
function moveTip(ev) {
  const r = $("side").getBoundingClientRect();
  let x = ev.clientX - r.left + 18, y = ev.clientY - r.top + 18;
  if (x + tip.offsetWidth > r.width) x = ev.clientX - r.left - tip.offsetWidth - 18;
  if (y + tip.offsetHeight > r.height) y = ev.clientY - r.top - tip.offsetHeight - 18;
  tip.style.left = Math.max(0, x) + "px"; tip.style.top = Math.max(0, y) + "px";
}
function hideTip() { tip.classList.remove("show"); }
$("graph").addEventListener("pointerover", (e) => { const n = nodeOf(e.target); setHot(n); if (n && n.kind !== "core") showTip(n, e); else hideTip(); });
$("graph").addEventListener("pointermove", (e) => { if (tip.classList.contains("show")) moveTip(e); });
$("graph").addEventListener("pointerleave", () => { setHot(null); hideTip(); });
$("graph").addEventListener("click", (e) => { const n = nodeOf(e.target); if (!n) return; if (n.kind === "story") jumpTo(n.item); else if (n.kind === "topic") toggleLens(n.topic); });
$("side").addEventListener("pointerenter", () => { news.hover = true; });
$("side").addEventListener("pointerleave", () => { news.hover = false; });
$("lens").addEventListener("click", () => { news.topic = null; rebuildQueue(false); paintLens(); if (news.cur) buildGraph(news.cur); });
let rsz = 0;
addEventListener("resize", () => { clearTimeout(rsz); rsz = setTimeout(() => { if (news.cur) buildGraph(news.cur); }, 250); });

function paintStatus() {
  const live = $("live"), upd = $("upd");
  const stale = !news.lastOk || Date.now() - news.lastOk > CONFIG.REFRESH_MS * 3;
  const stamp = news.generated || news.lastOk;
  live.classList.toggle("stale", stale);
  live.textContent = stale ? "Offline" : "Live";
  upd.textContent = stamp ? "Updated " + ago(stamp) : "Connecting";
}

/* ============================================================
   Clock + anti-burn-in drift
   ============================================================ */
function tickClock() {
  const d = new Date();
  $("clk").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  $("dte").textContent = d.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" });
  const it = news.queue[news.idx]; if (it) $("age").textContent = ago(it.ts);
  paintStatus();
}
setInterval(tickClock, 15000); tickClock();
setInterval(() => { $("frame").style.transform = `translate(${rand(-14, 14).toFixed(1)}px, ${rand(-10, 10).toFixed(1)}px)`; }, 60000);

/* ============================================================
   Music
   ============================================================ */
/* Two decks overlap: the next track is prefetched ~25 s before the end, then fades in (equal-power)
   while the current one fades out. Fades are time-based, so they stay smooth even if timers are throttled. */
const XF_MS = 7000, XF_FAST = 2500, PREFETCH_S = 25;
const decks = [new Audio(), new Audio()];
decks.forEach((d) => { d.preload = "auto"; d.volume = 0; });
const music = { order: [], i: -1, on: false, a: 0, cur: null, nextMeta: null, busy: false, muted: false, fails: 0, ramps: new Map() };
const act = () => decks[music.a], idl = () => decks[1 - music.a];
const easeIn = (k) => Math.sin(k * Math.PI / 2), easeOut = (k) => 1 - Math.cos(k * Math.PI / 2);   // sin/cos pair = constant power
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function pickTrack() {
  if (!music.order.length || music.i + 1 >= music.order.length) {
    const o = shuffle(TRACKS);
    if (music.cur && o.length > 1 && o[0] === music.cur) o.push(o.shift());       // never repeat across a reshuffle
    music.order = o; music.i = 0;
  } else music.i++;
  return music.order[music.i];
}
function ramp(d, to, ms, curve, done) {
  clearInterval(music.ramps.get(d));
  const from = d.volume, t0 = performance.now();
  const id = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    d.volume = clamp(from + (to - from) * curve(k), 0, 1);
    if (k >= 1) { clearInterval(id); music.ramps.delete(d); done && done(); }
  }, 40);
  music.ramps.set(d, id);
}
function creditNow() {
  if (!music.cur) return;
  $("tt").textContent = music.cur.title;
  $("cc").textContent = music.cur.by + " · Musopen · Public domain";
  if ("mediaSession" in navigator) { try { navigator.mediaSession.metadata = new MediaMetadata({ title: music.cur.title, artist: music.cur.by, album: "ThinkInfoSec Signal" }); } catch {} }
}
function giveUp() { music.on = false; $("np").classList.add("idle"); $("cc").textContent = "Audio unavailable in this browser"; }

function prepare() {                                      // choose the next track and let the idle deck buffer it silently
  if (music.nextMeta) return;
  const t = pickTrack(), d = idl();
  music.nextMeta = t; d.pause(); d.volume = 0; d.src = trackUrl(t.file); d.load();
}
async function crossfade(ms) {
  if (music.busy) return;
  music.busy = true;
  prepare();
  const out = act(), inn = idl(), t = music.nextMeta;
  music.nextMeta = null;
  try { inn.volume = 0; await inn.play(); }
  catch (e) {
    music.busy = false;
    if (e && e.name === "NotAllowedError") return giveUp();
    if (++music.fails > TRACKS.length * 2) return giveUp();
    return crossfade(ms);                                  // dead URL or unsupported codec: try another track
  }
  music.fails = 0; music.a = 1 - music.a; music.cur = t;   // the new deck is audible now; the old one keeps playing while it fades
  ramp(inn, CONFIG.VOLUME, ms, easeIn);
  ramp(out, 0, ms, easeOut, () => { out.pause(); music.busy = false; });
  setTimeout(creditNow, ms / 2);
  $("pg").style.transform = "scaleX(0)";
}
async function playMusic() {
  if (music.busy) return;
  const d = act();
  if (!music.cur) {                                        // very first start
    for (let tries = 0; tries < TRACKS.length; tries++) {
      const t = pickTrack(); d.src = trackUrl(t.file); d.volume = 0;
      try { await d.play(); music.cur = t; break; }
      catch (e) { if (e && e.name === "NotAllowedError") return giveUp(); }
    }
    if (!music.cur) return giveUp();
  } else {
    try { d.volume = 0; await d.play(); } catch { return; }
  }
  music.on = true; creditNow(); $("np").classList.remove("idle");
  ramp(d, CONFIG.VOLUME, music.cur && d.currentTime > 1 ? 1200 : 2500, easeIn);
}
function pauseMusic() {
  music.on = false; music.busy = false;
  decks.forEach((d) => { if (!d.paused) ramp(d, 0, 1000, easeOut, () => d.pause()); });
  $("np").classList.add("idle"); $("cc").textContent = "Paused · press space to play";
}
function toggleMute() { music.muted = !music.muted; decks.forEach((d) => { d.muted = music.muted; }); }

decks.forEach((d, idx) => {
  d.addEventListener("timeupdate", () => {
    if (idx !== music.a || !music.on || !d.duration) return;
    $("pg").style.transform = `scaleX(${(d.currentTime / d.duration).toFixed(4)})`;
    const left = d.duration - d.currentTime;
    if (left <= PREFETCH_S && !music.nextMeta && !music.busy) prepare();
    if (left <= XF_MS / 1000 + 0.3 && d.duration > 20 && !music.busy) crossfade(XF_MS);
  });
  d.addEventListener("ended", () => { if (idx === music.a && music.on && !music.busy) crossfade(600); });   // short clip, or a throttled timer: still hand over smoothly
  d.addEventListener("error", () => {
    if (idx !== music.a) { music.nextMeta = null; music.fails++; return; }          // a prefetch failed: pick another when the time comes
    if (music.on && !music.busy) { music.fails++; crossfade(800); }
  });
});
if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () => playMusic());
    navigator.mediaSession.setActionHandler("pause", () => pauseMusic());
    navigator.mediaSession.setActionHandler("nexttrack", () => { if (music.on) crossfade(XF_FAST); });
  } catch {}
}

/* ============================================================
   Painterly canvas — bristle strokes along a slow flow field
   ============================================================ */
const cv = $("paint"), ctx = cv.getContext("2d");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SC = 0.5;                       // render at half resolution: cheaper, and stains want to be soft anyway
let W = 0, H = 0, T = 0, strokes = [], frameN = 0, lastSpawn = 0;
const PAL = {
  dark:  ["0,191,207", "76,141,224", "127,231,239", "255,45,120", "255,128,180", "190,150,255"],
  light: ["0,175,194", "42,95,196", "196,20,111", "255,45,120", "255,120,170", "120,90,210"],
};
const sprites = {};
function sprite(rgb) {               // soft round blot, cached per colour
  if (sprites[rgb]) return sprites[rgb];
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, `rgba(${rgb},1)`); r.addColorStop(0.35, `rgba(${rgb},.55)`);
  r.addColorStop(0.7, `rgba(${rgb},.14)`); r.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return (sprites[rgb] = c);
}
function resize() {
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * SC); cv.height = Math.round(H * SC);
  ctx.setTransform(SC, 0, 0, SC, 0, 0);
  ctx.clearRect(0, 0, W, H); strokes = [];
}
addEventListener("resize", resize); resize();

function flow(x, y) {
  const s = 0.0013;
  return Math.sin(x * s * 1.3 + T * 0.04) * 2.1 + Math.cos(y * s * 1.7 - T * 0.03) * 2.1 + Math.sin((x + y) * s * 0.7 + T * 0.025) * 1.2;
}
function spawn() {
  const unit = Math.min(W, H) / 900;
  let x, y;
  if (Math.random() < 0.6) {                        // favour the rim, but let some stains wander inland
    const d = Math.pow(Math.random(), 2) * 0.3, side = Math.floor(Math.random() * 4);
    if (side === 0) { x = rand(0, W); y = d * H; } else if (side === 1) { x = rand(0, W); y = H - d * H; }
    else if (side === 2) { x = d * W; y = rand(0, H); } else { x = W - d * W; y = rand(0, H); }
  } else { x = rand(0, W); y = rand(0, H); }
  const light = document.documentElement.dataset.theme === "light", k = light ? 1.6 : 1;
  const pal = PAL[light ? "light" : "dark"];
  strokes.push({ x, y, k: 0, max: rand(280, 640), v: rand(0.9, 1.7) * unit + 0.4, r: rand(55, 140) * unit + 20,
    a: rand(0.014, 0.032) * k, seed: rand(0, 6.28), col: pal[Math.floor(Math.random() * pal.length)] });
}
function stepStroke(s) {
  const ang = flow(s.x, s.y) + Math.sin(s.k * 0.015 + s.seed) * 0.7;   // gentle wander so it meanders, not streaks
  s.x += Math.cos(ang) * s.v; s.y += Math.sin(ang) * s.v; s.k++;
  const p = s.k / s.max, env = Math.pow(Math.sin(Math.PI * clamp(p, 0, 1)), 0.8);
  const r = s.r * (0.75 + 0.25 * Math.sin(s.k * 0.03 + s.seed)) * (0.5 + 0.5 * env);
  ctx.globalAlpha = s.a * env;
  ctx.drawImage(sprite(s.col), s.x - r, s.y - r, r * 2, r * 2);
  return s.k < s.max && s.x > -160 && s.x < W + 160 && s.y > -160 && s.y < H + 160;
}
let lastFrame = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (document.hidden || now - lastFrame < 33) return;   // ~30 fps is plenty
  lastFrame = now; T += 0.033; frameN++;
  ctx.globalAlpha = 1;
  // very slow dissolve so stains linger; a stronger pass now and then clears 8-bit residue
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = `rgba(0,0,0,${frameN % 40 === 0 ? 0.06 : 0.005})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";
  if (now - lastSpawn > (reduce ? 2600 : 1000) && strokes.length < (reduce ? 4 : 11)) { spawn(); lastSpawn = now; }
  strokes = strokes.filter((s) => { for (let i = 0; i < 2; i++) if (!stepStroke(s)) return false; return true; });
  ctx.globalAlpha = 1;
  tickGraph();
  if (dwellStart) $("dw").style.transform = `scaleX(${clamp((performance.now() - dwellStart) / dwellLen, 0, 1).toFixed(3)})`;
}
requestAnimationFrame(loop);

/* ============================================================
   Controls, fullscreen, wake lock, lifecycle
   ============================================================ */
let wake = null;
async function keepAwake() { try { if ("wakeLock" in navigator) wake = await navigator.wakeLock.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => { if (!document.hidden) { keepAwake(); refreshNews(); } });

function setTheme(t) { document.documentElement.dataset.theme = t; store.set("tis-theme2", t); ctx.clearRect(0, 0, W, H); strokes = []; }
function toggleFs() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); }

let started = false;
function begin() {
  if (started) return; started = true;
  $("start").classList.add("gone");
  keepAwake(); playMusic();
  document.documentElement.requestFullscreen?.().catch(() => {});
}
addEventListener("pointerdown", begin);

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (!started) { begin(); return; }
  if (k === " ") { e.preventDefault(); music.on ? pauseMusic() : playMusic(); }
  else if (k === "n") { music.on ? crossfade(XF_FAST) : playMusic(); }
  else if (k === "m") toggleMute();
  else if (k === "arrowright") showNext(1);
  else if (k === "arrowleft") showNext(-1);
  else if (k === "1" || k === "2" || k === "3") { news.filter = { 1: "all", 2: "cyber", 3: "geo" }[k]; rebuildQueue(true); }
  else if (k === "t") setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  else if (k === "f") toggleFs();
  else if (k === "h") $("help").classList.toggle("gone");
  else if (k === "escape" && news.topic) { news.topic = null; rebuildQueue(false); paintLens(); if (news.cur) buildGraph(news.cur); }
});

let idle = 0;
addEventListener("pointermove", () => { document.body.classList.add("show-cursor"); clearTimeout(idle); idle = setTimeout(() => document.body.classList.remove("show-cursor"), 2500); });

// boot
const saved = store.get("tis-theme2"); if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
refreshNews(); setInterval(refreshNews, CONFIG.REFRESH_MS);
