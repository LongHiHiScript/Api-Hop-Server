"use strict";

const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

//================ CẤU HÌNH ================//
const API_KEY = process.env.API_KEY || ""; // để trống = không kiểm tra key
const TTL = (Number(process.env.TTL_MINUTES) || 5) * 60 * 1000;
const MAX_ENTRIES = 20000;
const JOB_ID_PATTERN = /^[\w-]{1,64}$/;

const GROUPS = {
    boss: "Boss",
    event: "Event",
    fruit: "Fruit",
    item: "Vật phẩm",
};

// name: tên chuẩn script dùng khi báo / đọc API
// aliases: các tên gọi khác, tự bỏ khoảng trắng và ký tự đặc biệt khi so khớp
const CATEGORIES = [
    { name: "Soul Reaper", group: "boss", aliases: ["reaper"] },
    { name: "Cake Prince", group: "boss", aliases: ["kata", "katakuri"] },
    { name: "Elite", group: "boss", aliases: ["elitehunter"] },
    { name: "Rip Indra", group: "boss", aliases: ["indra"] },
    { name: "Dough King", group: "boss", aliases: ["dough"] },
    { name: "Tyrant Of The Skies", group: "boss", aliases: ["tyrant", "tos"] },
    { name: "Darkbeard", group: "boss", aliases: ["dark"] },
    { name: "Cursed Captain", group: "boss", aliases: ["cursedcap"] },
    { name: "Cake Queen", group: "boss", aliases: ["queen"] },
    { name: "Longma", group: "boss", aliases: [] },

    { name: "Fullmoon", group: "event", aliases: ["full"] },
    { name: "NearMoon", group: "event", aliases: ["near"] },
    { name: "Mirage", group: "event", aliases: ["mirageisland"] },
    { name: "PrehistoricIsland", group: "event", aliases: ["prehistoric"] },
    { name: "KitsuneIsland", group: "event", aliases: ["kitsune"] },
    { name: "CastleRaid", group: "event", aliases: ["castle", "raidcastle"] },

    { name: "Fruits", group: "fruit", aliases: ["fruit"] },
    { name: "Berry", group: "fruit", aliases: ["berries"] },

    { name: "SwordLegendary", group: "item", aliases: ["sword", "legendarysword", "Legendary Sword Dealer"] },
];

const normalize = (value) => String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9]/g, "");

// khóa chuẩn hoá -> category
const CATEGORY_LOOKUP = new Map();
for (const category of CATEGORIES) {
    category.slug = normalize(category.name);
    CATEGORY_LOOKUP.set(category.slug, category);
    for (const alias of category.aliases) {
        CATEGORY_LOOKUP.set(normalize(alias), category);
    }
}

const findCategory = (name) => CATEGORY_LOOKUP.get(normalize(name)) || null;

// trang tổng hợp: /boss /event /fruit /item
const AGGREGATES = {
    boss: { group: "boss", title: "Tất cả Boss" },
    event: { group: "event", title: "Tất cả Event" },
    fruit: { group: "fruit", title: "Tất cả Fruit" },
    item: { group: "item", title: "Vật phẩm" },
};

//================ LƯU TRỮ ================//
const servers = new Map(); // key: name|jobId
const makeKey = (name, jobId) => `${name}|${jobId}`;

function pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of servers) {
        if (now - entry.time > TTL) {
            servers.delete(key);
        }
    }
}

function enforceCapacity() {
    while (servers.size > MAX_ENTRIES) {
        const oldestKey = servers.keys().next().value;
        servers.delete(oldestKey);
    }
}

function queryEntries(predicate) {
    pruneExpired();
    const result = [];
    for (const entry of servers.values()) {
        if (predicate(entry)) {
            result.push(entry);
        }
    }
    return result.sort((a, b) => b.time - a.time);
}

const toPublic = (entry) => ({
    placeId: entry.placeId,
    jobId: entry.jobId,
    name: entry.name,
    group: entry.group,
    players: entry.players,
    maxPlayers: entry.maxPlayers,
    detail: entry.detail,
    time: entry.time,
    ageSeconds: Math.floor((Date.now() - entry.time) / 1000),
});

setInterval(pruneExpired, 60 * 1000).unref();

//================ TIỆN ÍCH ================//
const esc = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const toInt = (value, max) => {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 0) {
        return 0;
    }
    return Math.min(number, max);
};

function safeEqual(a, b) {
    const bufferA = Buffer.from(String(a));
    const bufferB = Buffer.from(String(b));
    if (bufferA.length !== bufferB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufferA, bufferB);
}

const auth = (req, res, next) => {
    if (!API_KEY || safeEqual(req.get("x-key") || "", API_KEY)) {
        return next();
    }
    return res.sendStatus(401);
};

const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

function formatAge(seconds) {
    if (seconds < 60) {
        return `${seconds}s trước`;
    }
    return `${Math.floor(seconds / 60)}p ${seconds % 60}s trước`;
}

//================ GIAO DIỆN ================//
const STYLE = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:sans-serif;background:#111;color:#eee;padding:16px}
a{color:#6cf;text-decoration:none}
nav{margin-bottom:16px;line-height:2}
nav b{color:#aaa;margin-right:6px}
nav a{display:inline-block;margin-right:10px}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #333;padding:8px;word-break:break-all}
th{background:#222}
button{background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:4px;padding:4px 8px}
</style>`;

function buildNav() {
    const sections = Object.keys(GROUPS).map((groupKey) => {
        const links = CATEGORIES.filter((c) => c.group === groupKey)
            .map((c) => `<a href="/${esc(c.slug)}">${esc(c.name)}</a>`)
            .join("");
        return `<div><b><a href="/${groupKey}">[${esc(GROUPS[groupKey])}]</a></b>${links}</div>`;
    });
    return `<nav>${sections.join("")}</nav>`;
}

const NAV = buildNav();

function renderTable(entries, showCategory) {
    const rows = entries
        .map((entry) => {
            const age = Math.floor((Date.now() - entry.time) / 1000);
            return `<tr>
  ${showCategory ? `<td>${esc(entry.name)}</td>` : ""}
  <td>${esc(entry.players)}/${esc(entry.maxPlayers)}</td>
  <td>${esc(entry.detail || "-")}</td>
  <td>${esc(entry.placeId)}</td>
  <td>${esc(entry.jobId)} <button onclick="navigator.clipboard.writeText('${esc(entry.jobId)}')">Copy</button></td>
  <td>${esc(formatAge(age))}</td>
</tr>`;
        })
        .join("");

    const headers = `${showCategory ? "<th>Loại</th>" : ""}<th>Người chơi</th><th>Chi tiết</th><th>Game ID</th><th>Job ID</th><th>Cập nhật</th>`;
    const columns = showCategory ? 6 : 5;

    return `<div class="table-wrap"><table><tr>${headers}</tr>
${rows || `<tr><td colspan="${columns}">Chưa có server nào</td></tr>`}</table></div>`;
}

function renderPage(title, entries, showCategory) {
    return `<!doctype html><html><head>${STYLE}<meta http-equiv="refresh" content="15">
<title>${esc(title)} - TopiHub</title></head><body>
<h2><a href="/">TopiHub</a> / ${esc(title)}</h2>
${NAV}
${renderTable(entries, showCategory)}
</body></html>`;
}

//================ API ================//
app.get("/health", (req, res) => {
    res.json({ status: "ok", entries: servers.size });
});

app.post("/report", limiter, auth, (req, res) => {
    const body = req.body || {};
    const category = findCategory(body.name);
    const placeId = Number(body.placeId);
    const jobId = typeof body.jobId === "string" ? body.jobId : "";

    if (!category || !Number.isSafeInteger(placeId) || placeId <= 0 || !JOB_ID_PATTERN.test(jobId)) {
        return res.sendStatus(400);
    }

    const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 64) : "";
    const key = makeKey(category.name, jobId);

    servers.delete(key); // xoá rồi set lại để giữ thứ tự cũ nhất ở đầu Map
    servers.set(key, {
        placeId,
        jobId,
        name: category.name,
        group: category.group,
        players: toInt(body.players, 100),
        maxPlayers: toInt(body.maxPlayers, 100),
        detail,
        time: Date.now(),
    });
    enforceCapacity();

    return res.json({ ok: true });
});

app.post("/remove", limiter, auth, (req, res) => {
    const body = req.body || {};
    const category = findCategory(body.name);
    const jobId = typeof body.jobId === "string" ? body.jobId : "";

    if (category && JOB_ID_PATTERN.test(jobId)) {
        servers.delete(makeKey(category.name, jobId));
    }
    return res.json({ ok: true });
});

app.get("/api", limiter, (req, res) => {
    res.json({
        groups: Object.keys(AGGREGATES),
        names: CATEGORIES.map((c) => c.name),
    });
});

// Tương thích script ZFree Hop: /api/find?type=boss&value=Cake%20Prince&sea=3
// Trả { success, data: [...] }, lọc theo sea dựa trên placeId
const SEA_PLACES = {
    1: new Set([2753915549, 85211729168715]),
    2: new Set([4442272183, 79091703265657]),
};

function matchesSea(placeId, sea) {
    if (sea === "1" || sea === "2") {
        return SEA_PLACES[sea].has(placeId);
    }
    if (sea === "3") {
        return !SEA_PLACES[1].has(placeId) && !SEA_PLACES[2].has(placeId);
    }
    return true;
}

app.get("/api/find", limiter, (req, res) => {
    const category = findCategory(req.query.value);
    if (!category) {
        return res.json({ success: false, data: [] });
    }

    const sea = String(req.query.sea || "");
    const entries = queryEntries((entry) => entry.name === category.name && matchesSea(entry.placeId, sea));
    return res.json({ success: true, data: entries.map(toPublic) });
});

// Script đọc: /api/Elite, /api/Cake%20Prince, /api/kata, /api/boss, /api/event, /api/fruit, /api/item
app.get("/api/:name", limiter, (req, res) => {
    const key = normalize(req.params.name);

    const aggregate = AGGREGATES[key];
    if (aggregate) {
        return res.json(queryEntries((entry) => entry.group === aggregate.group).map(toPublic));
    }

    const category = findCategory(key);
    if (!category) {
        return res.status(404).json({ error: "Link không hợp lệ" });
    }
    return res.json(queryEntries((entry) => entry.name === category.name).map(toPublic));
});

//================ TRANG WEB ================//
app.get("/", (req, res) => {
    res.send(`<!doctype html><html><head>${STYLE}<title>TopiHub</title></head><body>
<h2>TopiHub</h2>${NAV}</body></html>`);
});

app.get("/:slug", (req, res, next) => {
    const key = normalize(req.params.slug);

    const aggregate = AGGREGATES[key];
    if (aggregate) {
        const entries = queryEntries((entry) => entry.group === aggregate.group);
        return res.send(renderPage(aggregate.title, entries, true));
    }

    const category = CATEGORIES.find((c) => c.slug === key); // trang riêng chỉ nhận đúng slug chuẩn
    if (!category) {
        return next();
    }

    const entries = queryEntries((entry) => entry.name === category.name);
    return res.send(renderPage(category.name, entries, false));
});

//================ LỖI ================//
app.use((req, res) => {
    res.status(404).send(`<!doctype html><html><head>${STYLE}<title>404</title></head><body>
<h2>Link không hợp lệ</h2><p>Chỉ có các link sau:</p>${NAV}</body></html>`);
});

app.use((err, req, res, next) => {
    const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? "internal_error" : "bad_request" });
});

app.listen(process.env.PORT || 3000);
