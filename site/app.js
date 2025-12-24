async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return await res.json();
}

function qs(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

function catLabel(cat) {
  if (cat === "A_GLOBAL") return "A 世界";
  if (cat === "B_JAPAN") return "B 日本";
  return "C Biz/AI";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

async function getLikesMap() {
  const base = window.LIKE_API_BASE;
  if (!base || base.includes("PUT_YOUR")) return {};
  try {
    const res = await fetch(`${base}?action=likes`, { cache: "no-store" });
    const data = await res.json();
    return data.likes ?? {};
  } catch {
    return {};
  }
}

async function sendReaction(newsId, type) {
  const base = window.LIKE_API_BASE;
  if (!base || base.includes("PUT_YOUR")) {
    alert("先に site/config.js の LIKE_API_BASE をGAS URLに設定してください。");
    return null;
  }
  const res = await fetch(`${base}?action=react`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ newsId, type })
  });
  return await res.json();
}

function buildButton(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}

(async function main() {
  // 共通メタ
  let meta = {};
  try {
    meta = await fetchJson("./data/build_meta.json");
    const buildLine = document.getElementById("buildLine");
    if (buildLine) buildLine.textContent = `更新: ${meta.builtAtJst ?? "-"}`;
    const footerLine = document.getElementById("footerLine");
    if (footerLine) footerLine.textContent = `データ: RSS（直近72h） / 自動更新: 毎日8:00(JST) / build: ${meta.buildId ?? "-"}`;
  } catch {}

  // index
  if (!location.pathname.includes("news.html")) {
    const today = await fetchJson("./data/today.json");
    const likes = await getLikesMap();

    const dateLine = document.getElementById("dateLine");
    if (dateLine) dateLine.textContent = today.dateKey ? `${today.dateKey}（JST）` : "Today";

    const ip = document.getElementById("importantPoints");
    if (ip) {
      ip.innerHTML = "";
      (today.importantPoints ?? []).forEach(x => {
        const li = document.createElement("li");
        li.textContent = x;
        ip.appendChild(li);
      });
    }

    const imps = document.getElementById("implications");
    if (imps) {
      imps.innerHTML = "";
      (today.implications ?? []).forEach(x => {
        const li = document.createElement("li");
        li.textContent = x;
        imps.appendChild(li);
      });
    }

    const list = document.getElementById("newsList");
    list.innerHTML = "";

    (today.articles ?? []).forEach(a => {
      const card = document.createElement("div");
      card.className = "card";

      const top = document.createElement("div");
      top.className = "row";

      const badges = document.createElement("div");
      badges.className = "badges";
      const b1 = document.createElement("span");
      b1.className = "badge cat";
      b1.textContent = catLabel(a.category);
      badges.appendChild(b1);

      const b2 = document.createElement("span");
      b2.className = "badge";
      b2.textContent = a.sourceName ?? "source";
      badges.appendChild(b2);

      top.appendChild(badges);

      const right = document.createElement("div");
      right.className = "count";
      const likeCount = likes[a.id] ?? 0;
      right.textContent = `👍 ${likeCount}`;
      top.appendChild(right);

      const link = document.createElement("a");
      link.href = `./news.html?id=${encodeURIComponent(a.id)}`;
      link.innerHTML = `<div class="title">${esc(a.title)}</div><div class="short">${esc(a.summaryShort)}</div>`;

      const tags = document.createElement("div");
      tags.className = "badges";
      (a.tags ?? []).slice(0, 6).forEach(t => {
        const s = document.createElement("span");
        s.className = "badge";
        s.textContent = t;
        tags.appendChild(s);
      });

      card.appendChild(top);
      card.appendChild(link);
      card.appendChild(tags);

      list.appendChild(card);
    });

    return;
  }

  // news detail
  if (location.pathname.includes("news.html")) {
    const id = qs("id");
    const items = await fetchJson("./data/items.json");
    const likes = await getLikesMap();
    const a = (items.items ?? []).find(x => x.id === id);

    if (!a) {
      document.getElementById("newsTitle").textContent = "Not Found";
      return;
    }

    document.getElementById("newsTitle").textContent = a.title;
    document.getElementById("newsMeta").textContent = `${catLabel(a.category)} / ${a.sourceName ?? ""} / ${a.publishedAtJst ?? "-"}`;

    const tagBadges = document.getElementById("tagBadges");
    tagBadges.innerHTML = "";
    (a.tags ?? []).forEach(t => {
      const s = document.createElement("span");
      s.className = "badge";
      s.textContent = t;
      tagBadges.appendChild(s);
    });

    const btnBar = document.getElementById("btnBar");
    btnBar.innerHTML = "";
    const countSpan = document.createElement("span");
    countSpan.className = "count";
    countSpan.textContent = `👍 ${likes[a.id] ?? 0}`;

    const likeBtn = buildButton("👍 いいね", async () => {
      likeBtn.disabled = true;
      const r = await sendReaction(a.id, "LIKE");
      likeBtn.disabled = false;
      if (r && r.ok) countSpan.textContent = `👍 ${r.likes ?? (likes[a.id] ?? 0)}`;
    });
    const dislikeBtn = buildButton("👎 いまいち", async () => {
      dislikeBtn.disabled = true;
      await sendReaction(a.id, "DISLIKE");
      dislikeBtn.disabled = false;
      alert("OK（翌日以降の選定に反映されます）");
    });
    const saveBtn = buildButton("★ 保存", async () => {
      saveBtn.disabled = true;
      await sendReaction(a.id, "SAVE");
      saveBtn.disabled = false;
      alert("OK（保存として記録しました）");
    });

    btnBar.appendChild(likeBtn);
    btnBar.appendChild(dislikeBtn);
    btnBar.appendChild(saveBtn);
    btnBar.appendChild(countSpan);

    document.getElementById("newsBody").textContent = a.summaryFull;

    const ul = document.getElementById("sources");
    ul.innerHTML = "";
    (a.sources ?? []).forEach(s => {
      const li = document.createElement("li");
      li.innerHTML = `<a class="underline" href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.name)}</a>`;
      ul.appendChild(li);
    });
  }
})();
