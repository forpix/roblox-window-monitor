#!/usr/bin/env node
// Roblox codes/wiki 站群发现雷达（Part A，indie-builder-brain/briefs/2026-07-12-sitemap-discovery-radar.md）。
//
// 监控 TryHardGuides / Beebom / Dexerto 三个第三方 codes 站的 sitemap，判断它们是否已经给
// 某个 Roblox 游戏发了"codes for Game X"文章——这是竞争者已经注意到这个游戏的证据，
// 提醒 roblox-window-monitor 的 gate 体系去查一下域名。纯参考信号，不接入 gate A-D/alerts.json。
//
// 07-13 实测跟 brief 07-12 数字有部分drift（详见各 site 小节注释），三站都已现场核对过
// sitemap 结构/URL 规则/lastmod 是否还在，不是照抄 brief 数字。
//
// 统一原则（brief Part 0.3）：lastmod 只决定"这轮该不该重抓这个分片"，"是不是新页面"永远由
// URL 的 ever-seen 集合判断——三站不例外，一个编辑改老文章的兑换码不能看起来像新发现。
//
// 冷启动基线抑制按分片（不是按站）独立持久化：见 monitor.mjs 的 discovery-bootstrap.json 同一套
// 教训——某个分片这轮抓取失败，不能因为"站级跑过一轮了"就当它已经 bootstrap 完成；等它哪轮真
// 抓成功了，才对那一刻抓到的 URL 补记 baseline，不能读成 first_seen。

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const num = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
};
const TIMEOUT_MS = num('TIMEOUT_MS', 15000);
const RETRIES = num('RETRIES', 2);
const ENRICH_RETRY_MAX = num('ENRICH_RETRY_MAX', 5); // placeId->universeId 解析失败的重试上限

const STATE_DIR = process.env.GUIDE_STATE_DIR || 'state';
const NEWSEEN_FILE = process.env.GUIDE_NEWSEEN_FILE || `${STATE_DIR}/guide-newly-seen.jsonl`;
const RUNS_FILE = process.env.GUIDE_RUNS_FILE || `${STATE_DIR}/guide-source-runs.jsonl`;
const knownFile = site => process.env[`GUIDE_KNOWN_FILE_${site.toUpperCase()}`] || `${STATE_DIR}/guide-known-${site}.json`;

// 07-13 现场实测确认仍然有效的三站 sitemap 入口（见 robots.txt 的 Sitemap: 声明）
const TRYHARDGUIDES_INDEX = process.env.TRYHARDGUIDES_INDEX || 'https://tryhardguides.com/sitemap_index.xml';
const BEEBOM_INDEX        = process.env.BEEBOM_INDEX        || 'https://beebom.com/sitemap_index.xml';
const DEXERTO_MONTH_BASE  = process.env.DEXERTO_MONTH_BASE  || 'https://www.dexerto.com/post-sitemap.xml';

const DAY = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = a => 500 * 2 ** a + Math.floor(Math.random() * 250); // jittered

// browser-ish headers（TryHardGuides 已经 429 过一次，见 CLAUDE.md）——跟 monitor.mjs 同一份
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xml,application/json,text/plain,*/*',
};

let apiBlocked = false;
class BlockedError extends Error {}

// ---- http（跟 monitor.mjs 同一套 retry-on-403/429/5xx + jittered backoff）----
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

// placeId -> universeId（跟 monitor.mjs 同一个契约）
async function getUniverseId(placeId) {
  const j = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  return j.universeId;
}

// ---- sitemap 解析（正则，不上 XML 解析器——结构固定，零依赖）----
function extractIndexShards(xml) {
  return [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?\s*<\/sitemap>/g)]
    .map(m => ({ url: m[1], lastmod: m[2] || null }));
}
function extractUrlEntries(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(m => {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    const lastmod = m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] || null;
    return loc ? { url: loc, lastmod } : null;
  }).filter(Boolean);
}
function shardKeyFromUrl(url) {
  return url.split('/').filter(Boolean).pop();
}
// 三站都混着大量非 Roblox 内容（THG 有 wordle/crossword，Beebom 是综合科技站，Dexerto 是综合
// 游戏/娱乐新闻站）——收窄到"codes 类文章"。
// 07-13 实测修正：最初要求 url 同时含 roblox + codes/wiki，但 THG/Beebom 的 codes 文章 slug
// 惯例是 <game>-codes、绝大多数不带 roblox（THG 本周分片 168 篇 codes 只有 3 篇带 roblox，
// Beebom 319 篇只有 60 篇）——按 roblox 词过滤会丢 THG 98%/Beebom 80% 的目标文章。
// 现规则：slug 以 -codes 结尾（尾缀形态跟 extractGameName 的剥离规则同构：-codes /
// -codes-july2026 / -codes-<数字id>），或 roblox+wiki 组合（THG 的 wiki 类长 slug）。
// 非 Roblox 游戏的 codes 文章（少数）会混进来，由富化的 placeId 提取 + Part C 的 universeId
// 对齐兜底排除——这里选召回优先：漏掉信号比混进可排除的噪音贵得多。
function isCodesArticleUrl(url) {
  return /-codes(-[a-z]+-?\d{2,4})?(-\d+)?\/?$/i.test(url.replace(/[?#].*$/, ''))
    || (/roblox/i.test(url) && /wiki/i.test(url));
}

// ---- 游戏名提取（A.3）：从 URL 最后一段 slug 提取，允许失败，永远保留 rawSlug ----
function extractGameName(url) {
  const rawSlug = (url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()) || '';
  let s = rawSlug;
  s = s.replace(/^roblox-/i, '');
  s = s.replace(/-codes(-[a-z]+-?\d{2,4})?(-\d+)?$/i, ''); // -codes / -codes-july2026 / -codes-<数字id>(Dexerto)
  s = s.replace(/-\d+$/, ''); // 剩余的纯数字尾巴（Dexerto 文章 ID）
  const words = s.split('-').filter(Boolean);
  const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  // 残留 "codes"/"wiki" 或纯数字说明前后缀规则没套上——诚实标失败，而不是硬凑一个脏名字
  const extracted = words.length > 0 && !/codes|wiki/i.test(name) && !/^\d+$/.test(s);
  return { rawSlug, extractedGameName: extracted ? name : null, extracted };
}

// ---- state io ----
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

function loadKnownState(site) {
  const j = loadJson(knownFile(site), null);
  return {
    everSeenUrls: new Set(j?.everSeenUrls || []),
    lastmodByUrl: j?.lastmodByUrl || {},
    childLastmods: j?.childLastmods || {},
    bootstrappedShards: j?.bootstrappedShards || {},
    enrichmentByUrl: j?.enrichmentByUrl || {},
  };
}
function saveKnownState(site, k, nowIso) {
  writeFileMkdir(knownFile(site), JSON.stringify({
    everSeenUrls: [...k.everSeenUrls],
    lastmodByUrl: k.lastmodByUrl,
    childLastmods: k.childLastmods,
    bootstrappedShards: k.bootstrappedShards,
    enrichmentByUrl: k.enrichmentByUrl,
    updatedAt: nowIso,
  }, null, 2));
}

function appendRunHealth(sourceKey, runId, startedAt, finishedAt, status, fetchedCount, eligibleCount, error) {
  appendFileMkdir(RUNS_FILE, JSON.stringify({
    runId, sourceKey, scheduledAt: startedAt, startedAt, finishedAt,
    status, fetchedCount, eligibleCount, error: error ?? null,
  }) + '\n');
}

// ---- 事件构造 ----
function baselineEvent(site, entry, runId, observedAt) {
  const { rawSlug, extractedGameName, extracted } = extractGameName(entry.url);
  return {
    eventType: 'baseline', leftCensored: true, observedAt, runId, site,
    url: entry.url, articleTitle: null, rawSlug, extractedGameName, extracted,
    placeId: null, universeId: null, extractionStatus: extracted ? 'name_only' : 'failed',
    lastmod: entry.lastmod ?? null, sourceLastmodTrusted: entry.lastmod != null,
  };
}

// 新增/更新事件：顺手抓正文找 roblox.com/games/{placeId} 链接（A.3 v2）——比规范化名字更可靠的
// 对齐主键，Roblox 游戏名经常高度通用（Knockout/Chameleon 这类）。抓不到也不丢记录。
async function enrichArticle(site, item, known) {
  const { rawSlug, extractedGameName, extracted } = extractGameName(item.url);
  let articleTitle = null;
  let placeId = null;
  try {
    const res = await httpFetch(item.url);
    if (res.ok) {
      const text = await res.text();
      articleTitle = (text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim() || null;
      const m = text.match(/roblox\.com\/games\/(\d+)/i);
      if (m) placeId = Number(m[1]);
    } else if (res.status === 403 || res.status === 429) {
      apiBlocked = true;
    }
  } catch (e) {
    console.warn(`[warn] ${site} 文章抓取失败 ${item.url}: ${e.message}`);
  }
  const extractionStatus = placeId ? 'exact_id' : (extracted ? 'name_only' : 'failed');

  let universeId = null;
  if (placeId) {
    const prev = known.enrichmentByUrl[item.url] || { status: 'pending', attempts: 0 };
    try {
      universeId = await getUniverseId(placeId);
      known.enrichmentByUrl[item.url] = { status: 'done', attempts: prev.attempts + 1, placeId, universeId };
    } catch (e) {
      if (e instanceof BlockedError) apiBlocked = true;
      const attempts = prev.attempts + 1;
      known.enrichmentByUrl[item.url] = { status: attempts >= ENRICH_RETRY_MAX ? 'failed' : 'pending', attempts, placeId };
    }
  }

  return {
    eventType: item.eventType, leftCensored: false, observedAt: item.observedAt, runId: item.runId, site,
    url: item.url, articleTitle, rawSlug, extractedGameName, extracted,
    placeId, universeId, extractionStatus,
    lastmod: item.lastmod ?? null, sourceLastmodTrusted: item.lastmod != null,
  };
}

// universeId 解析失败要能重试（up to ENRICH_RETRY_MAX），不是首次失败就永久 null——重试状态/次数
// 存在 known-state 的 enrichmentByUrl 里；guide-newly-seen.jsonl 是 append-only 的历史事件流，
// 事件行里的 universeId 是"写入那一刻"的快照，后续重试解析成功与否，以 guide-known-{site}.json
// 的 enrichmentByUrl 为准（下游要拿最新解析结果，应该查这份文件，不是重新扫事件日志）。
async function retryPendingEnrichments(known) {
  for (const [url, st] of Object.entries(known.enrichmentByUrl)) {
    if (st.status !== 'pending' || !st.placeId) continue;
    if (st.attempts >= ENRICH_RETRY_MAX) { known.enrichmentByUrl[url] = { ...st, status: 'failed' }; continue; }
    try {
      const universeId = await getUniverseId(st.placeId);
      known.enrichmentByUrl[url] = { ...st, status: 'done', attempts: st.attempts + 1, universeId };
    } catch (e) {
      if (e instanceof BlockedError) apiBlocked = true;
      const attempts = st.attempts + 1;
      known.enrichmentByUrl[url] = { ...st, attempts, status: attempts >= ENRICH_RETRY_MAX ? 'failed' : 'pending' };
    }
  }
}

// ---- 站点适配器：各自决定"这轮该检查哪些分片"，返回统一形状交给 processSite 处理 ----
// { shardsToCheck: [{shardKey, url, indexLastmod}], healthWarnings: [string] }；index 本身抓不到就抛错。

// TryHardGuides：周分片，索引层带每周 lastmod；抓所有 lastmod 变化的分片（不只是最新一周）。
async function listShardsTryHardGuides(known) {
  const xml = await getText(TRYHARDGUIDES_INDEX);
  const shards = extractIndexShards(xml).filter(s => /\/post-sitemap-\d{4}-\d{1,2}\.xml$/.test(s.url));
  if (!shards.length) throw new Error('sitemap index 里没有匹配的周分片——结构可能变了，先手动检查');
  const shardsToCheck = shards
    .map(s => ({ shardKey: shardKeyFromUrl(s.url), url: s.url, indexLastmod: s.lastmod }))
    .filter(s => known.childLastmods[s.shardKey] !== s.indexLastmod);
  return { shardsToCheck, healthWarnings: [] };
}

// Beebom：55 个编号分片（07-13 实测：实际是 50 个 post-sitemapN.xml + 4 个 page/category/tag/author
// 分片混在同一个索引里，跟 brief 07-12 的"55"数字有出入，需要用 /post-sitemap\d*\.xml$/ 过滤掉
// 非 post 类型分片）。编号不代表时间顺序——每轮读全部分片的 lastmod，抓所有变化的（不是挑最新的
// 1-2 个），并检查"最新 lastmod 的分片是不是编号最高"，不是就只 warn 不失败。
function beebomShardNumber(url) {
  const m = url.match(/post-sitemap(\d*)\.xml$/);
  if (!m) return null;
  return m[1] === '' ? 1 : Number(m[1]); // 无编号的 post-sitemap.xml 视为分片 1
}
async function listShardsBeebom(known) {
  const xml = await getText(BEEBOM_INDEX);
  const shards = extractIndexShards(xml).filter(s => /\/post-sitemap\d*\.xml$/.test(s.url));
  if (!shards.length) throw new Error('sitemap index 里没有匹配的 post-sitemap 分片——结构可能变了，先手动检查');

  const healthWarnings = [];
  const withLastmod = shards.filter(s => s.lastmod);
  if (withLastmod.length) {
    const maxNum = Math.max(...withLastmod.map(s => beebomShardNumber(s.url) ?? -1));
    const latest = [...withLastmod].sort((a, b) => (a.lastmod < b.lastmod ? 1 : a.lastmod > b.lastmod ? -1 : 0))[0];
    const latestNum = beebomShardNumber(latest.url);
    if (latestNum !== maxNum) {
      healthWarnings.push(`最新 lastmod 的分片是 #${latestNum}（${latest.url}），不是编号最高的 #${maxNum}——分片规则可能变了，建议人工复核`);
    }
  }

  const shardsToCheck = shards
    .map(s => ({ shardKey: shardKeyFromUrl(s.url), url: s.url, indexLastmod: s.lastmod }))
    .filter(s => known.childLastmods[s.shardKey] !== s.indexLastmod);
  return { shardsToCheck, healthWarnings };
}

// Dexerto：月度分片（?year=&month=），索引本身没有 lastmod（07-13 实测确认，07-12 brief 没提这点）。
// 不靠 lastmod 决定抓哪个分片——直接锁定当月+上月（处理跨月边界），每轮都抓这两个，不依赖索引。
function dexertoTargetMonths(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const key = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}`;
  const url = (yy, mm) => `${DEXERTO_MONTH_BASE}?year=${yy}&month=${mm}`;
  return [
    { shardKey: key(y, m), url: url(y, m), indexLastmod: undefined },
    { shardKey: key(prevY, prevM), url: url(prevY, prevM), indexLastmod: undefined },
  ];
}
async function listShardsDexerto(known, now) {
  return { shardsToCheck: dexertoTargetMonths(now), healthWarnings: [] };
}

// ---- 每站处理主流程（bootstrap/diff/富化/健康记录全部按分片粒度隔离，一站失败不影响其他站）----
async function processSite(cfg, runId, nowIso) {
  const known = loadKnownState(cfg.key);
  const startedAt = new Date().toISOString();

  let shardsResult;
  let indexError = null;
  try {
    shardsResult = await cfg.listShards(known);
  } catch (e) {
    if (e instanceof BlockedError) apiBlocked = true;
    indexError = e.message;
    shardsResult = { shardsToCheck: [], healthWarnings: [] };
  }
  for (const w of shardsResult.healthWarnings) console.warn(`[warn] ${cfg.key}: ${w}`);

  if (indexError) {
    const finishedAt = new Date().toISOString();
    appendRunHealth(cfg.key, runId, startedAt, finishedAt, 'error', 0, 0, indexError);
    console.error(`[error] ${cfg.key}: 索引抓取失败: ${indexError} — 本轮不更新 known-state`);
    return;
  }

  const attempted = shardsResult.shardsToCheck.length;
  let succeeded = 0;
  const pendingEnrich = [];

  for (const shard of shardsResult.shardsToCheck) {
    let entries;
    try {
      const xml = await getText(shard.url);
      entries = extractUrlEntries(xml).filter(e => isCodesArticleUrl(e.url));
    } catch (e) {
      if (e instanceof BlockedError) apiBlocked = true;
      console.warn(`[warn] ${cfg.key} 分片抓取失败 ${shard.url}: ${e.message}`);
      continue; // 不碰这个分片的 childLastmods/bootstrappedShards——保持 pending，下轮自然重试
    }
    succeeded++;
    const shardObservedAt = new Date().toISOString();
    const alreadyBootstrapped = known.bootstrappedShards[shard.shardKey]?.bootstrapped;

    if (!alreadyBootstrapped) {
      // 这个分片第一次真正抓成功——建基线，不管站级别是不是已经跑了很多轮
      for (const e of entries) {
        appendFileMkdir(NEWSEEN_FILE, JSON.stringify(baselineEvent(cfg.key, e, runId, shardObservedAt)) + '\n');
        known.everSeenUrls.add(e.url);
        if (e.lastmod) known.lastmodByUrl[e.url] = e.lastmod;
      }
      known.bootstrappedShards[shard.shardKey] = { bootstrapped: true, bootstrappedAt: shardObservedAt };
    } else {
      for (const e of entries) {
        if (!known.everSeenUrls.has(e.url)) {
          pendingEnrich.push({ url: e.url, lastmod: e.lastmod, eventType: 'first_seen', observedAt: shardObservedAt, runId });
          known.everSeenUrls.add(e.url);
        } else if (e.lastmod && known.lastmodByUrl[e.url] !== e.lastmod) {
          pendingEnrich.push({ url: e.url, lastmod: e.lastmod, eventType: 'updated', observedAt: shardObservedAt, runId });
        }
        if (e.lastmod) known.lastmodByUrl[e.url] = e.lastmod;
      }
    }
    // 只在这个分片真正抓成功时才推进它的 lastmod 记账——分片失败时保留旧值，下轮天然被判定为"变了"再抓一次
    if (shard.indexLastmod !== undefined) known.childLastmods[shard.shardKey] = shard.indexLastmod;
  }

  for (const item of pendingEnrich) {
    const enriched = await enrichArticle(cfg.key, item, known);
    appendFileMkdir(NEWSEEN_FILE, JSON.stringify(enriched) + '\n');
  }
  await retryPendingEnrichments(known);

  const finishedAt = new Date().toISOString();
  const status = attempted === 0 ? 'ok' : succeeded === attempted ? 'ok' : succeeded === 0 ? 'error' : 'partial';
  appendRunHealth(cfg.key, runId, startedAt, finishedAt, status, succeeded, attempted,
    status === 'ok' ? null : `${succeeded}/${attempted} 分片成功`);

  saveKnownState(cfg.key, known, nowIso);
  if (pendingEnrich.length) console.log(`${cfg.key}: 本轮 ${pendingEnrich.length} 条 first_seen/updated`);
}

// ---- main ----
const now = Date.now();
const nowIso = new Date(now).toISOString();
const runId = nowIso;

const SITE_CONFIGS = [
  { key: 'tryhardguides', listShards: k => listShardsTryHardGuides(k) },
  { key: 'beebom', listShards: k => listShardsBeebom(k) },
  { key: 'dexerto', listShards: k => listShardsDexerto(k, new Date(now)) },
];

for (const cfg of SITE_CONFIGS) {
  try {
    await processSite(cfg, runId, nowIso);
  } catch (e) {
    // 兜底：某一站代码本身抛未捕获异常，也不能连累其他两站——记一条 error 健康记录就跳过
    console.error(`[error] ${cfg.key} 处理异常: ${e.stack || e.message}`);
    appendRunHealth(cfg.key, runId, nowIso, new Date().toISOString(), 'error', 0, 0, e.message);
  }
}

if (apiBlocked) {
  console.log('\n⚠️  API_BLOCKED — 目标站返回 403/429/bot-challenge，本轮数据可能不完整。');
}
