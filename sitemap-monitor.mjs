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
const ENRICH_MAX_PER_RUN = num('ENRICH_MAX_PER_RUN', 120); // 回填队列每轮处理上限，防 API 滥用
const ENRICH_MAX_ATTEMPTS = 8; // 重试到此次数移入 failed 留审计

const SITEMAP_INDEX = process.env.SITEMAP_INDEX || 'https://www.roblox.com/sitemap-games.xml';
const KNOWN_FILE     = process.env.KNOWN_FILE     || 'state/sitemap-known.json';
const NEWSEEN_FILE   = process.env.NEWSEEN_FILE   || 'state/sitemap-newly-seen.jsonl';
const RUNS_FILE      = process.env.RUNS_FILE      || 'state/sitemap-source-runs.jsonl';
const QUEUE_FILE     = process.env.QUEUE_FILE     || 'state/sitemap-enrich-queue.json';
const BASELINE_FILE  = process.env.BASELINE_FILE  || 'state/sitemap-baseline.json';
// ENRICH_ONLY=1：跳过 sitemap 抓取/diff/基线，只处理富化回填队列（本地住宅 IP 回填用，
// GH Actions 数据中心 IP 会被 Roblox games API 403）。此模式不写 roblox-sitemap 健康记录。
const ENRICH_ONLY = process.env.ENRICH_ONLY === '1';

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

// -> { entries, expectedShards, succeededShards } — caller decides whether the run was clean
// enough to persist (Part 0.2: a partial shard failure must not overwrite the baseline with an
// incomplete set, or the failed shard's placeIds look like "new" once it's fetched successfully
// again next run).
async function fetchAllGameEntries() {
  const indexXml = await getText(SITEMAP_INDEX);
  const shardUrls = extractLocs(indexXml);
  if (!shardUrls.length) throw new Error('sitemap index 里没有分片 <loc>——结构可能变了，先手动检查');
  const entries = new Map(); // placeId -> slug
  let succeededShards = 0;
  for (const shardUrl of shardUrls) {
    try {
      const xml = await getText(shardUrl);
      for (const loc of extractLocs(xml)) {
        const g = parseGameUrl(loc);
        if (g) entries.set(g.placeId, g.slug);
      }
      succeededShards++;
    } catch (e) {
      if (e instanceof BlockedError) apiBlocked = true;
      console.warn(`[warn] shard failed ${shardUrl}: ${e.message}`);
    }
  }
  return { entries, expectedShards: shardUrls.length, succeededShards };
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

// items: [{placeId, ...}] -> [{...item, universeId, game}]（失败为 null）。
// 发现时富化和队列回填共用，节奏都是 RESOLVE_BATCH 并发 + games API 100 一批。
async function resolveBatches(items) {
  const out = [];
  for (let i = 0; i < items.length; i += RESOLVE_BATCH) {
    const batch = items.slice(i, i + RESOLVE_BATCH);
    const universeIds = await Promise.all(batch.map(async (b) => {
      try { return await getUniverseId(b.placeId); }
      catch (e) { if (e instanceof BlockedError) apiBlocked = true; return null; }
    }));
    const resolved = batch.map((b, j) => ({ ...b, universeId: universeIds[j] ?? null }));
    const games = await getGamesChunked(resolved.filter(p => p.universeId).map(p => p.universeId));
    const byUniverse = new Map(games.map(g => [g.id, g]));
    for (const p of resolved) out.push({ ...p, game: p.universeId ? (byUniverse.get(p.universeId) ?? null) : null });
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

// ---- 富化回填队列 ----
// 发现时富化失败的 placeId 进 pending（事件本身照常立即写、universeId 为 null——首见时间戳
// 神圣不可改），每轮在正常流程后重试；成功时以 enriched 事件回填（保留原始 seenAt）。
function loadQueue() {
  if (existsSync(QUEUE_FILE)) {
    const q = loadJson(QUEUE_FILE, {});
    return { pending: q.pending ?? {}, failed: q.failed ?? {} };
  }
  // 种子：queue 文件不存在时扫既有事件日志，universeId 为 null 且没有后续 enriched 事件的
  // first_seen/reentered 全部进 pending——历史欠账自动进入回填轨道
  const pending = {};
  let events = [];
  try {
    events = readFileSync(NEWSEEN_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {}
  const enrichedIds = new Set(events.filter(e => e.eventType === 'enriched').map(e => e.placeId));
  for (const e of events) {
    if ((e.eventType === 'first_seen' || e.eventType === 'reentered')
        && e.universeId === null && !enrichedIds.has(e.placeId)) {
      pending[e.placeId] ??= { seenAt: e.seenAt, attempts: 0 }; // 同 placeId 多条时取最早那条的 seenAt
    }
  }
  return { pending, failed: {} };
}

// ---- main ----
const now = Date.now();
const nowIso = new Date(now).toISOString();
const runId = nowIso;
const startedAt = nowIso;

const queue = loadQueue();
let queueDirty = !existsSync(QUEUE_FILE); // 刚做过种子就得落盘
const queuedThisRun = new Set(); // 本轮发现时刚失败入队的，别在同一轮的队列处理里立刻重试
// enrich 健康计数：发现时富化 + 队列重试共用一条轨迹（sourceKey roblox-sitemap-enrich）
let enrichAttempted = 0;
let enrichSucceeded = 0;

function enqueueFailed(placeId, seenAt) {
  const key = String(placeId);
  if (queue.pending[key] || queue.failed[key]) return; // 已在队列，原始 seenAt 不覆盖
  queue.pending[key] = { seenAt, attempts: 0 };
  queuedThisRun.add(key);
  queueDirty = true;
}

if (!ENRICH_ONLY) {
  const known = loadJson(KNOWN_FILE, null); // null = 冷启动，没有基线可对比

  // Part 0.2: index/shard fetch health — must be a persisted, traceable fact regardless of whether
  // the run ends up clean enough to update the baseline (a partial run's health record is exactly
  // what lets Part C tell "this source was down" apart from "this source found nothing new").
  let fetchResult = null;
  let indexError = null;
  try {
    fetchResult = await fetchAllGameEntries();
  } catch (e) {
    if (e instanceof BlockedError) apiBlocked = true;
    indexError = e.message;
    console.error(`[error] sitemap index 抓取失败: ${e.message}`);
  }
  const finishedAt = new Date().toISOString();
  const expectedShards = fetchResult?.expectedShards ?? 0;
  const succeededShards = fetchResult?.succeededShards ?? 0;
  const current = fetchResult?.entries ?? new Map();
  // 全部分片必须成功才能更新基线——分片失败会用残缺集合覆盖 known.json，下一轮网络恢复、
  // 之前失败的分片重新抓到时，那批游戏的 placeId 会被误判成"新增"（假新增）。
  const allShardsOk = fetchResult !== null && succeededShards === expectedShards;
  const runStatus = indexError ? 'error' : allShardsOk ? 'ok' : 'partial';

  appendFileMkdir(RUNS_FILE, JSON.stringify({
    runId, sourceKey: 'roblox-sitemap', scheduledAt: startedAt, startedAt, finishedAt,
    status: runStatus, fetchedCount: succeededShards, eligibleCount: expectedShards,
    error: indexError,
  }) + '\n');

  if (!allShardsOk) {
    console.error(`分片未全部成功（${succeededShards}/${expectedShards}）——本轮不更新基线，非零退出，下一轮重新全量抓取。`);
    process.exitCode = 1;
  } else {
    console.log(`抓到 sitemap 当前 ${current.size} 条游戏 URL（${SITEMAP_INDEX}）`);

    if (known === null) {
      // 冷启动：只建基线，不判定新增——没有上一轮，"全部都是新的"这句话没有信息量
      const placeIds = [...current.keys()];
      writeFileMkdir(KNOWN_FILE, JSON.stringify({
        currentPlaceIds: placeIds, everSeenPlaceIds: placeIds, updatedAt: nowIso, totalRuns: 1,
      }, null, 2));
      // 左删失基线：观测开始时就已在 sitemap 里的集合。下游读事件日志时必须知道这批游戏
      // 不是"S6 最早发现"的。只在冷启动写一次，之后任何轮次都不碰。
      if (!existsSync(BASELINE_FILE)) {
        writeFileMkdir(BASELINE_FILE, JSON.stringify({
          generatedAt: nowIso, leftCensored: true, placeIds,
        }, null, 2));
      }
      console.log(`首次运行：建立基线 ${current.size} 个已知游戏，本轮不判定新增（下一轮才有 diff）。`);
    } else {
      // currentPlaceIds = 上一轮快照（判定 reentered 用），everSeenPlaceIds = 历史累计、永不删除
      // （判定 first_seen 用）——旧版 known.json 只有单一的 placeIds 字段，两个概念都从它初始化，
      // 一次性完成迁移。
      const prevCurrentSet = new Set(known.currentPlaceIds ?? known.placeIds ?? []);
      const everSeenSet = new Set(known.everSeenPlaceIds ?? known.placeIds ?? []);

      const toEnrich = [];
      for (const [placeId, slug] of current.entries()) {
        if (!everSeenSet.has(placeId)) toEnrich.push({ placeId, slug, eventType: 'first_seen' });
        else if (!prevCurrentSet.has(placeId)) toEnrich.push({ placeId, slug, eventType: 'reentered' });
      }
      const removedCount = [...prevCurrentSet].filter(id => !current.has(id)).length;
      const firstSeenCount = toEnrich.filter(e => e.eventType === 'first_seen').length;
      const reenteredCount = toEnrich.filter(e => e.eventType === 'reentered').length;
      console.log(`本轮新增 ${firstSeenCount} 个，重新上榜 ${reenteredCount} 个，从榜单消失 ${removedCount} 个（第 ${(known.totalRuns || 0) + 1} 轮）。`);

      // 新增 + 重新上榜都做 CCU/age 富化——正常情况下是小批量；解析失败的也记一条，不静默丢
      const resolved = await resolveBatches(toEnrich);
      enrichAttempted += toEnrich.length;
      const enriched = [];
      for (const p of resolved) {
        const g = p.game;
        if (g) enrichSucceeded++;
        else enqueueFailed(p.placeId, nowIso); // 事件照写（universeId 可能 null），placeId 进回填队列
        enriched.push({
          eventType: p.eventType,
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

      for (const e of enriched) appendFileMkdir(NEWSEEN_FILE, JSON.stringify(e) + '\n');
      writeFileMkdir(KNOWN_FILE, JSON.stringify({
        currentPlaceIds: [...current.keys()],
        everSeenPlaceIds: [...new Set([...everSeenSet, ...current.keys()])],
        updatedAt: nowIso, totalRuns: (known.totalRuns || 0) + 1,
      }, null, 2));

      if (enriched.length) {
        console.table(enriched.map(e => ({
          event: e.eventType, name: e.name ?? '(解析失败)', placeId: e.placeId, ccu: e.playing ?? '—',
          ageDaysAtDiscovery: e.ageDaysAtDiscovery ?? '—',
        })));
      } else {
        console.log('本轮无新增。');
      }
    }
  }
}

// ---- 队列处理（每轮在正常流程后；ENRICH_ONLY 模式只做这一段）----
const retryKeys = Object.keys(queue.pending).filter(k => !queuedThisRun.has(k)).slice(0, ENRICH_MAX_PER_RUN);
if (retryKeys.length) {
  console.log(`回填队列：本轮重试 ${retryKeys.length} 个（pending 共 ${Object.keys(queue.pending).length}）`);
  const items = retryKeys.map(k => ({ key: k, placeId: Number(k), seenAt: queue.pending[k].seenAt }));
  const resolved = await resolveBatches(items);
  enrichAttempted += items.length;
  let backfilled = 0;
  for (const p of resolved) {
    const g = p.game;
    if (g) {
      enrichSucceeded++;
      backfilled++;
      appendFileMkdir(NEWSEEN_FILE, JSON.stringify({
        eventType: 'enriched',
        seenAt: p.seenAt, // 原始首见时间戳，不可改
        enrichedAt: nowIso,
        placeId: p.placeId,
        universeId: p.universeId,
        name: g.name ?? null,
        createdAt: g.created ?? null,
        // 用原始 seenAt 算——"发现时游戏多大"，不是"现在多大"
        ageDaysAtDiscovery: g.created ? Number(((new Date(p.seenAt).getTime() - new Date(g.created).getTime()) / DAY).toFixed(1)) : null,
        // 发现时的 CCU 已不可考，只能如实叫"回填时的 CCU"
        playingAtEnrich: g.playing ?? null,
      }) + '\n');
      delete queue.pending[p.key];
    } else {
      const entry = queue.pending[p.key];
      entry.attempts += 1;
      if (entry.attempts >= ENRICH_MAX_ATTEMPTS) { // 到上限移入 failed 留审计
        queue.failed[p.key] = entry;
        delete queue.pending[p.key];
      }
    }
  }
  queueDirty = true;
  console.log(`回填成功 ${backfilled}/${items.length}，剩余 pending ${Object.keys(queue.pending).length}，failed ${Object.keys(queue.failed).length}。`);
}
if (queueDirty) {
  writeFileMkdir(QUEUE_FILE, JSON.stringify({
    pending: queue.pending, failed: queue.failed, updatedAt: nowIso,
  }, null, 2));
}

// enrich 健康记录：富化环节自己的轨迹，跟分片抓取（roblox-sitemap）分开——分片全成功但
// games API 被 403 时，下游才能看出"这批 first_seen 是空心的"。每轮一条。
const enrichStatus = enrichAttempted === 0 || enrichSucceeded === enrichAttempted ? 'ok'
  : enrichSucceeded > 0 ? 'partial' : 'error';
appendFileMkdir(RUNS_FILE, JSON.stringify({
  runId, sourceKey: 'roblox-sitemap-enrich', scheduledAt: startedAt, startedAt,
  finishedAt: new Date().toISOString(), status: enrichStatus,
  fetchedCount: enrichSucceeded, eligibleCount: enrichAttempted,
  error: enrichStatus === 'ok' ? null : `${enrichAttempted - enrichSucceeded}/${enrichAttempted} placeId 富化失败`,
}) + '\n');

if (apiBlocked) {
  console.log('\n⚠️  API_BLOCKED — Roblox 返回 403/429/bot-challenge，本轮数据可能不完整。');
}
