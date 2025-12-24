import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const FEEDS_PATH = path.resolve("scripts/feeds.json");
const RULES_PATH = path.resolve("scripts/rules.json");

const OUT_TODAY = path.resolve("site/data/today.json");
const OUT_ITEMS = path.resolve("site/data/items.json");
const OUT_TAGW = path.resolve("site/data/tag_weights.json");
const OUT_META  = path.resolve("site/data/build_meta.json");

const LIKE_API_BASE = process.env.LIKE_API_BASE || ""; // 任意（Secretsに入れると反映）

function jstNowString() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace("T", " ").slice(0, 16) + " JST";
}
function dateKeyJst() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

function hashId(str) {
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 12);
}

function normalizeTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[【】\[\]（）\(\)「」『』]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toDateSafe(x) {
  if (!x) return null;
  const d = new Date(String(x));
  return Number.isFinite(d.getTime()) ? d : null;
}

function pickText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (v["#text"]) return v["#text"];
  }
  return String(v);
}

async function fetchXml(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed ${url}: ${res.status}`);
  return await res.text();
}

function parseFeed(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const data = parser.parse(xml);

  const rssItems = data?.rss?.channel?.item ?? data?.channel?.item ?? data?.rdf?.item ?? [];
  const atomEntries = data?.feed?.entry ?? [];
  const items = Array.isArray(rssItems) ? rssItems : (rssItems ? [rssItems] : []);
  const entries = Array.isArray(atomEntries) ? atomEntries : (atomEntries ? [atomEntries] : []);

  const out = [];

  for (const it of items) {
    const title = pickText(it?.title);
    let link = pickText(it?.link);
    if (typeof it?.link === "object" && it?.link?.href) link = it.link.href;

    const desc = pickText(it?.description) || pickText(it?.summary) || "";
    const pub = toDateSafe(it?.pubDate) || toDateSafe(it?.date) || null;

    if (title && link) out.push({ title, link, desc, pub });
  }

  for (const en of entries) {
    const title = pickText(en?.title);
    let link = "";
    if (Array.isArray(en?.link)) {
      const alt = en.link.find(x => x.rel === "alternate") || en.link[0];
      link = alt?.href || pickText(alt);
    } else {
      link = en?.link?.href || pickText(en?.link);
    }
    const desc = pickText(en?.summary) || pickText(en?.content) || "";
    const pub = toDateSafe(en?.published) || toDateSafe(en?.updated) || null;

    if (title && link) out.push({ title, link, desc, pub });
  }

  return out;
}

function addTagsAndCategory(item, rules) {
  const text = `${item.title} ${item.desc}`.toLowerCase();

  const tags = [];
  for (const tr of rules.tagRules) {
    if (tr.keywords.some(k => text.includes(String(k).toLowerCase()))) tags.push(tr.tag);
  }

  let category = "C_BIZ_AI";
  for (const cr of rules.categoryRules) {
    if (cr.keywords.some(k => text.includes(String(k).toLowerCase()))) {
      category = cr.category;
      break;
    }
  }

  if (["首相官邸","内閣府"].includes(item.sourceName)) category = "B_JAPAN";

  return { ...item, tags, category };
}

function isHiringish(tags, hiringTags) {
  return tags.some(t => hiringTags.includes(t));
}

function updateTagWeights(prev, items, likesMap) {
  const decay = 0.92;
  const next = { ...prev };
  for (const k of Object.keys(next)) next[k] = Number((next[k] * decay).toFixed(4));

  for (const it of items) {
    const likes = Number(likesMap[it.id] || 0);
    if (!likes) continue;
    const gain = Math.log1p(likes) * 0.35;
    for (const t of it.tags) {
      const v = (next[t] || 0) + gain;
      next[t] = Math.max(-3, Math.min(3, Number(v.toFixed(4))));
    }
  }
  return next;
}

function scoreItem(it, rules, tagWeights, likesMap) {
  const now = Date.now();
  const pub = it.pub ? it.pub.getTime() : now;
  const hours = Math.max(0, (now - pub) / 36e5);
  const recency = Math.max(0, 2.2 - Math.log1p(hours));

  const sourceW = rules.sourceWeights[it.sourceName] ?? 1.0;

  const tagBoost = (it.tags || []).reduce((s, t) => s + (tagWeights[t] || 0), 0);
  const likeBoost = Math.log1p(Number(likesMap[it.id] || 0)) * 0.6;

  return Number((sourceW + recency + tagBoost + likeBoost).toFixed(4));
}

function buildSummaryFull(it) {
  const title = it.title;
  const desc = (it.desc || "").replace(/\s+/g, " ").trim().slice(0, 280);

  const lines = [];
  lines.push("――――――――――");
  lines.push(`📰 ${title}`);
  lines.push("");
  lines.push("■ 概要（3行以内）");
  lines.push(`・${desc ? desc : "（RSSの概要情報が短いため、要点のみ表示）"}`);
  lines.push("・（出典リンク参照：一次情報/公式発表を優先）");
  lines.push("");
  lines.push("■ 背景・補足");
  lines.push(`・公開元：${it.sourceName}`);
  lines.push(`・公開日時：${it.publishedAtJst || "不明（RSSに日時が無い/取得不可）"}`);
  lines.push("");
  lines.push("■ ビジネス／採用への示唆");
  lines.push("・顧客提案：『影響領域（賃金/規制/AI/景況）』と『次アクション（集客/自動化/運用最適化）』を会話の起点にする");
  lines.push("・社内戦略：類似ニュースの継続ウォッチ（翌日以降の追加報道/公式発表）を前提に、施策の優先度を見直す");
  lines.push("――――――――――");
  return lines.join("\n");
}

async function fetchLikesMap() {
  if (!LIKE_API_BASE) return {};
  try {
    const res = await fetch(`${LIKE_API_BASE}?action=likes`, { cache: "no-store" });
    const data = await res.json();
    return data.likes ?? {};
  } catch {
    return {};
  }
}

(async function run() {
  const feeds = JSON.parse(fs.readFileSync(FEEDS_PATH, "utf-8")).feeds;
  const rules = JSON.parse(fs.readFileSync(RULES_PATH, "utf-8"));

  const likesMap = await fetchLikesMap();

  let prevW = {};
  try {
    prevW = JSON.parse(fs.readFileSync(OUT_TAGW, "utf-8")).weights || {};
  } catch {}

  const now = Date.now();
  const ms72h = 72 * 3600 * 1000;

  let raw = [];
  for (const f of feeds) {
    try {
      const xml = await fetchXml(f.url);
      const items = parseFeed(xml).map(x => ({
        id: hashId(x.link),
        title: x.title,
        url: x.link,
        desc: x.desc,
        pub: x.pub,
        sourceName: f.name
      }));
      raw.push(...items);
    } catch {
      continue;
    }
  }

  raw = raw.filter(x => !x.pub || (now - x.pub.getTime()) <= ms72h);

  const seen = new Set();
  const deduped = [];
  for (const it of raw) {
    const k = normalizeTitle(it.title);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }

  const enriched = deduped.map(it => addTagsAndCategory(it, rules));
  const nextW = updateTagWeights(prevW, enriched, likesMap);

  const scored = enriched.map(it => ({
    ...it,
    score: scoreItem(it, rules, nextW, likesMap)
  }));

  const A = scored.filter(x => x.category === "A_GLOBAL").sort((a,b)=>b.score-a.score);
  const B = scored.filter(x => x.category === "B_JAPAN").sort((a,b)=>b.score-a.score);
  const C = scored.filter(x => x.category === "C_BIZ_AI").sort((a,b)=>b.score-a.score);

  const picked = [];
  picked.push(...A.slice(0, rules.limits.minA));
  picked.push(...B.slice(0, rules.limits.minB));
  picked.push(...C.slice(0, rules.limits.minC));

  const rest = scored
    .filter(x => !picked.find(p => p.id === x.id))
    .sort((a,b)=>b.score-a.score);

  const maxTotal = rules.limits.maxTotal;
  const hiringCap = rules.limits.hiringCap;
  const hiringTags = rules.hiringTags;

  function hiringRatio(list) {
    const h = list.filter(x => isHiringish(x.tags, hiringTags)).length;
    return list.length ? h / list.length : 0;
  }

  for (const it of rest) {
    if (picked.length >= maxTotal) break;
    const trial = [...picked, it];
    if (hiringRatio(trial) > hiringCap) continue;
    picked.push(it);
  }

  const minTotal = rules.limits.minTotal;
  if (picked.length < minTotal) {
    for (const it of rest) {
      if (picked.length >= minTotal) break;
      if (!picked.find(p => p.id === it.id)) picked.push(it);
    }
  }

  const dateKey = dateKeyJst();

  const itemsOut = picked.map(it => {
    const pubJst = it.pub ? new Date(it.pub.getTime() + 9*3600*1000) : null;
    const publishedAtJst = pubJst ? pubJst.toISOString().replace("T"," ").slice(0,16) + " JST" : null;

    const summaryShort = it.desc
      ? it.desc.replace(/\s+/g," ").trim().slice(0, 70) + (it.desc.length > 70 ? "…" : "")
      : "要点は出典リンク参照（公式・一次情報優先）";

    return {
      id: it.id,
      title: it.title,
      category: it.category,
      tags: it.tags,
      sourceName: it.sourceName,
      publishedAtJst,
      summaryShort,
      summaryFull: buildSummaryFull({ ...it, publishedAtJst }),
      sources: [{ name: it.sourceName, url: it.url }]
    };
  });

  const top3 = itemsOut.slice(0,3);
  const importantPoints = [
    top3[0] ? `最重要：${top3[0].title}（${top3[0].category}）` : "—",
    top3[1] ? `次点：${top3[1].title}（${top3[1].category}）` : "—",
    top3[2] ? `注目：${top3[2].title}（${top3[2].category}）` : "—"
  ].filter(x => x !== "—");

  const implications = [
    "求人広告：景況/規制/AI動向に応じて、配分・訴求軸（給与/働き方/スキル）を微調整する",
    "AI面接：ルール・ガイドライン動向を追い、説明可能性/公平性を担保した導入提案を前提にする",
    "BPO：コスト圧力が強い局面ほど、非コア業務の外出し＋自動化で“採用に集中”を作る"
  ];

  fs.writeFileSync(OUT_ITEMS, JSON.stringify({ items: itemsOut }, null, 2), "utf-8");

  fs.writeFileSync(OUT_TODAY, JSON.stringify({
    dateKey,
    importantPoints,
    implications,
    articles: itemsOut.map(x => ({
      id: x.id,
      title: x.title,
      category: x.category,
      tags: x.tags,
      sourceName: x.sourceName,
      summaryShort: x.summaryShort,
      publishedAtJst: x.publishedAtJst
    }))
  }, null, 2), "utf-8");

  fs.writeFileSync(OUT_TAGW, JSON.stringify({
    updatedAtJst: jstNowString(),
    weights: nextW
  }, null, 2), "utf-8");

  fs.writeFileSync(OUT_META, JSON.stringify({
    builtAtJst: jstNowString(),
    buildId: hashId(`${Date.now()}`)
  }, null, 2), "utf-8");

  console.log(`OK: ${itemsOut.length} articles, dateKey=${dateKey}`);
})();
