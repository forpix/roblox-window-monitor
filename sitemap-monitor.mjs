#!/usr/bin/env node
// Roblox 官方 sitemap-games.xml 需求发现雷达。
//
// 抓 Roblox 自己的 SEO 精选榜（robots.txt 声明的 sitemap-games.xml，10 分片，约 1 万条游戏 URL），
// 跟上一轮的已知集合做差集：新出现的 placeId = Roblox 自己判定"值得索引"的新信号。
//
// 目的：验证这条线是否比 explore-api 的 up-and-coming/top-trending 更早发现新游戏——
// 官方图表有已知空窗（youngest charted ≈ 24d，<7 天的游戏进不去榜，见 monitor.mjs 的
// v2 discovery 记录），这份 sitemap 不受该图表算法约束，理论上可能更早。这是待验证假说，
// 需要跑几周攒历史才能回答，不是已确认的结论。
//
// Roblox 官方资源（roblox.com 自己的 sitemap），不引入第三方站点，符合 CLAUDE.md 的
// "Roblox only, 无第三方源" 硬约束。零 npm 依赖，Node 20+ ESM，无需密钥。
//
// 已知的数据形状（07-12 实测）：sitemap-games.xml 是个 index，10 个分片各 1000 条，
// 无 lastmod 字段——只能靠"URL 集合差集"判断新增，判断不了修改时间。抽样发现新旧
// placeId 混杂排列，不像按时间排序，大概率是 Roblox 内部某种质量/相关性分数选出的精选集，
// 不是全量游戏（Roblox 游戏总数是千万级，这里只有约 1 万条）。

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const num = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
};
const TIMEOUT_MS = num('TIMEOUT_MS', 15000);
const RETRIES = num('RETRIES', 2);
const RESOLVE_BATCH = num('RESOLVE_BATCH', 8); // 新增条目做 universeId 解析时的批大小

const SITEMAP_INDEX = process.env.SITEMAP_INDEX || 'https://www.roblox.com/sitemap-games.xml';
const KNOWN_FILE     = process.env.KNOWN_FILE     || 'state/sitemap-known.json';
const NEWSEEN_FILE   = process.env.NEWSEEN_FILE   || 'state/sitemap-newly-seen.jsonl';

const DAY = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = a => 500 * 2 ** a + Math.floor(Math.random() * 250); // jittered

// browser-ish headers reduce naive datacenter-IP bot-blocking（同 monitor.mjs 的既有教训）
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/xml, text/xml, application/json, text/plain, */*',
};

let apiBlocked = false;
class BlockedError extends Error {}

// ---- http (retry on 403/429/5xx with jittered backoff) ----
async function httpFetch(url, attempt = 0) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < RETRIES) {
      clearTimeout(t);
      await sleep(backoff(attempt));
      return httpFetch(url, attempt + 1);
    }
    return res;
  } catch (e) {
    clearTimeout(t);
    if (attempt < RETRIES) { await sleep(backoff(attempt)); return httpFetch(url, attempt + 1); }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function getText(url) {
  const res = await httpFetch(url);
  if (res.status === 403 || res.status === 429) throw new BlockedError(`HTTP ${res.status} ${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function getJson(url) {
  const text = await getText(url);
  try { return JSON.parse(text); }
  catch { throw new BlockedError(`non-JSON body, likely bot challenge: ${url}`); }
}

// ---- sitemap parsing (regex, not a full XML parser — sitemap 结构简单固定，零依赖) ----
function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
}

// https://www.roblox.com/games/{placeId}/{slug} -> {placeId, slug}
function parseGameUrl(url) {
  const m = url.match(/\/games\/(\d+)\/([^/?#]+)/);
  return m ? { placeId: Number(m[1]), slug: m[2] } : null;
}

async function fetchAllGameEntries() {
  const indexXml = await getText(SITEMAP_INDEX);
  const shardUrls = extractLocs(indexXml);
  if (!shardUrls.length) throw new Error('sitemap index 里没有分片 <loc>——结构可能变了，先手动检查');
  const entries = new Map(); // placeId -> slug
  for (const shardUrl of shardUrls) {
    try {
      const xml = await getText(shardUrl);
      for (const loc of extractLocs(xml)) {
        const g = parseGameUrl(loc);
        if (g) entries.set(g.placeId, g.slug);
      }
    } catch (e) {
      if (e instanceof BlockedError) apiBlocked = true;
      console.warn(`[warn] shard failed ${shardUrl}: ${e.message}`);
    }
  }
  return entries;
}

// ---- Roblox games API（同 monitor.mjs 的既有契约，用于给新增条目富化 CCU/age）----
async function getUniverseId(placeId) {
  const j = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  return j.universeId;
}
async function getGames(universeIds) {
  const j = await getJson(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(',')}`);
  return j.data || [];
}
async function getGamesChunked(universeIds) {
  const out = [];
  for (let i = 0; i < universeIds.length; i += 100) {
    try { out.push(...await getGames(universeIds.slice(i, i + 100))); }
    catch (e) {
      if (e instanceof BlockedError) apiBlocked = true;
      console.warn(`[warn] CCU batch chunk@${i} failed: ${e.message}`);
    }
  }
  return out;
}

// ---- state ----
function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeFileMkdir(file, data) {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, data);
}
function appendFileMkdir(file, line) {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, line);
}

// ---- main ----
const now = Date.now();
const nowIso = new Date(now).toISOString();

const known = loadJson(KNOWN_FILE, null); // null = 冷启动，没有基线可对比
const current = await fetchAllGameEntries();
console.log(`抓到 sitemap 当前 ${current.size} 条游戏 URL（${SITEMAP_INDEX}）`);

if (known === null) {
  // 冷启动：只建基线，不判定新增——没有上一轮，"全部都是新的"这句话没有信息量
  writeFileMkdir(KNOWN_FILE, JSON.stringify({
    placeIds: [...current.keys()], updatedAt: nowIso, totalRuns: 1,
  }, null, 2));
  console.log(`首次运行：建立基线 ${current.size} 个已知游戏，本轮不判定新增（下一轮才有 diff）。`);
} else {
  const knownSet = new Set(known.placeIds);
  const newEntries = [...current.entries()].filter(([placeId]) => !knownSet.has(placeId));
  const removedCount = known.placeIds.filter(id => !current.has(id)).length;
  console.log(`本轮新增 ${newEntries.length} 个，从榜单消失 ${removedCount} 个（第 ${(known.totalRuns || 0) + 1} 轮）。`);

  // 只对新增的做 CCU/age 富化——正常情况下是小批量；解析失败的也记一条，不静默丢
  const enriched = [];
  for (let i = 0; i < newEntries.length; i += RESOLVE_BATCH) {
    const batch = newEntries.slice(i, i + RESOLVE_BATCH);
    const universeIds = await Promise.all(batch.map(async ([placeId]) => {
      try { return await getUniverseId(placeId); }
      catch (e) { if (e instanceof BlockedError) apiBlocked = true; return null; }
    }));
    const resolved = batch.map((b, j) => ({ placeId: b[0], slug: b[1], universeId: universeIds[j] }));
    const games = await getGamesChunked(resolved.filter(p => p.universeId).map(p => p.universeId));
    const byUniverse = new Map(games.map(g => [g.id, g]));
    for (const p of resolved) {
      const g = p.universeId ? byUniverse.get(p.universeId) : null;
      enriched.push({
        seenAt: nowIso,
        placeId: p.placeId,
        slug: p.slug,
        universeId: p.universeId ?? null,
        name: g?.name ?? null,
        playing: g?.playing ?? null,
        createdAt: g?.created ?? null,
        ageDaysAtDiscovery: g?.created ? Number(((now - new Date(g.created).getTime()) / DAY).toFixed(1)) : null,
      });
    }
  }

  for (const e of enriched) appendFileMkdir(NEWSEEN_FILE, JSON.stringify(e) + '\n');
  writeFileMkdir(KNOWN_FILE, JSON.stringify({
    placeIds: [...current.keys()], updatedAt: nowIso, totalRuns: (known.totalRuns || 0) + 1,
  }, null, 2));

  if (enriched.length) {
    console.table(enriched.map(e => ({
      name: e.name ?? '(解析失败)', placeId: e.placeId, ccu: e.playing ?? '—',
      ageDaysAtDiscovery: e.ageDaysAtDiscovery ?? '—',
    })));
  } else {
    console.log('本轮无新增。');
  }
}

if (apiBlocked) {
  console.log('\n⚠️  API_BLOCKED — Roblox 返回 403/429/bot-challenge，本轮数据可能不完整。');
}
