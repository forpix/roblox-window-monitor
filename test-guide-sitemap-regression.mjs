#!/usr/bin/env node
// 离线回归：guide-sitemap-monitor 的冷启动/diff/分片粒度 bootstrap 安全网。
// 不碰真实网络、不碰真实 state。覆盖 brief Part A 验收清单：
//   1. 冷启动：300 个历史 URL 只建基线，first_seen 事件数为 0
//   2. 第二轮出现新 URL → 正确识别为 1 条 first_seen（含正文富化：placeId/universeId）
//   3. 已见过的 URL lastmod 变化 → updated（不是 first_seen）
//   4. 一个分片这轮失败、下一轮才真正抓成功 → 那一刻才补记 baseline，不跟其他分片的 bootstrap 混淆
//   5. Beebom：分片 lastmod 乱序读取，确认是按 lastmod 变化选分片，不是按编号选
// 跑法：node test-guide-sitemap-regression.mjs；断言失败即非零退出。

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RETRIES = '0';
process.env.TIMEOUT_MS = '2000';

const text = s => new Response(s, { status: 200 });
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const status = code => new Response('', { status: code });

const indexXml = shards => `<?xml version="1.0"?><sitemapindex>${
  shards.map(s => `<sitemap><loc>${s.loc}</loc>${s.lastmod ? `<lastmod>${s.lastmod}</lastmod>` : ''}</sitemap>`).join('')
}</sitemapindex>`;
const urlsetXml = urls => `<?xml version="1.0"?><urlset>${
  urls.map(u => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('')
}</urlset>`;
const articleHtml = ({ title, placeId }) =>
  `<html><head><title>${title}</title></head><body>${placeId ? `<a href="https://roblox.com/games/${placeId}/Some-Game">Play</a>` : ''}</body></html>`;

let failed = 0;
const expect = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed += 1; };

function freshDir(name) {
  return mkdtempSync(join(tmpdir(), `guide-regression-${name}-`));
}
function readJsonl(file) {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

// ==================================================================================
// Suite 1（TryHardGuides 单分片）：冷启动 300 条 → first_seen → updated
// ==================================================================================
{
  const tmp = freshDir('s1');
  process.env.GUIDE_STATE_DIR = tmp;
  const KNOWN = join(tmp, 'guide-known-tryhardguides.json');
  const NEWSEEN = join(tmp, 'guide-newly-seen.jsonl');
  const RUNS = join(tmp, 'guide-source-runs.jsonl');

  const N = 300;
  const baselineUrls = Array.from({ length: N }, (_, i) => ({ loc: `https://tryhardguides.com/roblox-game${i + 1}-codes/`, lastmod: '2026-06-01T00:00:00+00:00' }));
  const NEW_URL = 'https://tryhardguides.com/roblox-game301-codes/';
  const UPDATED_URL = baselineUrls[4].loc; // game5

  let round = 1;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('tryhardguides.com/sitemap_index.xml')) {
      const lastmod = round === 1 ? 'L0' : round === 2 ? 'L1' : 'L2';
      return text(indexXml([{ loc: 'https://tryhardguides.com/post-sitemap-2026-1.xml', lastmod }]));
    }
    if (u.includes('post-sitemap-2026-1.xml')) {
      if (round === 1) return text(urlsetXml(baselineUrls));
      if (round === 2) return text(urlsetXml([...baselineUrls, { loc: NEW_URL, lastmod: '2026-07-01T00:00:00+00:00' }]));
      // round 3: game5 的 lastmod 变了，其余不变
      const urls = [...baselineUrls, { loc: NEW_URL, lastmod: '2026-07-01T00:00:00+00:00' }]
        .map(u2 => u2.loc === UPDATED_URL ? { ...u2, lastmod: '2026-07-10T00:00:00+00:00' } : u2);
      return text(urlsetXml(urls));
    }
    if (u === NEW_URL) return text(articleHtml({ title: 'Game301 Codes', placeId: 999888 }));
    if (u === UPDATED_URL) return text(articleHtml({ title: 'Game5 Codes (Updated)', placeId: null }));
    if (u.includes('/universes/v1/places/999888/universe')) return json({ universeId: 42 });
    throw new Error('suite1 unexpected fetch: ' + u);
  };

  await import(`./guide-sitemap-monitor.mjs?s1round=1`);
  const known1 = JSON.parse(readFileSync(KNOWN, 'utf8'));
  expect('冷启动建立 300 条 everSeenUrls', known1.everSeenUrls.length === N);
  const events1 = readJsonl(NEWSEEN);
  expect('冷启动只产出 baseline 事件（300 条）', events1.length === N && events1.every(e => e.eventType === 'baseline' && e.leftCensored === true));
  expect('冷启动不产出 first_seen', events1.filter(e => e.eventType === 'first_seen').length === 0);
  const thgRuns1 = readJsonl(RUNS).filter(r => r.sourceKey === 'tryhardguides');
  expect('冷启动健康记录 ok', thgRuns1.length === 1 && thgRuns1[0].status === 'ok');

  round = 2;
  await import(`./guide-sitemap-monitor.mjs?s1round=2`);
  const events2 = readJsonl(NEWSEEN);
  const firstSeen2 = events2.filter(e => e.eventType === 'first_seen');
  expect('第二轮只产生 1 条 first_seen', firstSeen2.length === 1);
  expect('新增 URL 正确', firstSeen2[0]?.url === NEW_URL);
  expect('新增文章 placeId 富化成功（exact_id）', firstSeen2[0]?.placeId === 999888 && firstSeen2[0]?.extractionStatus === 'exact_id');
  expect('新增文章 universeId 解析成功', firstSeen2[0]?.universeId === 42);
  expect('新增文章标题富化成功', firstSeen2[0]?.articleTitle === 'Game301 Codes');
  const known2 = JSON.parse(readFileSync(KNOWN, 'utf8'));
  expect('第二轮 everSeenUrls 累加为 301', known2.everSeenUrls.length === N + 1);

  round = 3;
  await import(`./guide-sitemap-monitor.mjs?s1round=3`);
  const events3 = readJsonl(NEWSEEN);
  const updated3 = events3.filter(e => e.eventType === 'updated');
  const firstSeen3 = events3.filter(e => e.eventType === 'first_seen');
  expect('第三轮：lastmod 变化的已知 URL 产生 updated（不是 first_seen）', updated3.length === 1 && updated3[0]?.url === UPDATED_URL);
  expect('第三轮：全程 first_seen 总数仍是 1（不会被 updated 重复计）', firstSeen3.length === 1);
  expect('updated 事件 extractionStatus 未找到链接时是 name_only', updated3[0]?.extractionStatus === 'name_only');
}

// ==================================================================================
// Suite 2（TryHardGuides 双分片）：分片这轮失败、下一轮才真正抓成功 → 那一刻才 baseline
// ==================================================================================
{
  const tmp = freshDir('s2');
  process.env.GUIDE_STATE_DIR = tmp;
  const KNOWN = join(tmp, 'guide-known-tryhardguides.json');
  const NEWSEEN = join(tmp, 'guide-newly-seen.jsonl');
  const RUNS = join(tmp, 'guide-source-runs.jsonl');

  const shardAUrls = Array.from({ length: 10 }, (_, i) => ({ loc: `https://tryhardguides.com/roblox-a${i + 1}-codes/`, lastmod: 'A0' }));
  const shardBUrls = Array.from({ length: 5 }, (_, i) => ({ loc: `https://tryhardguides.com/roblox-b${i + 1}-codes/`, lastmod: 'B0' }));

  let round = 1;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('tryhardguides.com/sitemap_index.xml')) {
      return text(indexXml([
        { loc: 'https://tryhardguides.com/post-sitemap-2026-1.xml', lastmod: 'A0' },
        { loc: 'https://tryhardguides.com/post-sitemap-2026-2.xml', lastmod: 'B0' },
      ]));
    }
    if (u.includes('post-sitemap-2026-1.xml')) return text(urlsetXml(shardAUrls));
    if (u.includes('post-sitemap-2026-2.xml')) {
      if (round === 1) return status(500); // 分片 B 这轮抓取失败
      return text(urlsetXml(shardBUrls)); // 第二轮才真正抓成功
    }
    throw new Error('suite2 unexpected fetch: ' + u);
  };

  await import(`./guide-sitemap-monitor.mjs?s2round=1`);
  const known1 = JSON.parse(readFileSync(KNOWN, 'utf8'));
  expect('分片 A 成功：everSeenUrls 里有 10 条 A', shardAUrls.every(u => known1.everSeenUrls.includes(u.loc)));
  expect('分片 B 失败：everSeenUrls 里没有任何 B', !shardBUrls.some(u => known1.everSeenUrls.includes(u.loc)));
  expect('分片 A 已 bootstrap', known1.bootstrappedShards['post-sitemap-2026-1.xml']?.bootstrapped === true);
  expect('分片 B 尚未 bootstrap', !known1.bootstrappedShards['post-sitemap-2026-2.xml']?.bootstrapped);
  const events1 = readJsonl(NEWSEEN);
  expect('第一轮只有分片 A 的 10 条 baseline', events1.length === 10 && events1.every(e => e.eventType === 'baseline'));
  const thgRuns1 = readJsonl(RUNS).filter(r => r.sourceKey === 'tryhardguides');
  expect('第一轮健康记录 partial（2 个分片，1 个成功）', thgRuns1[0].status === 'partial' && thgRuns1[0].fetchedCount === 1 && thgRuns1[0].eligibleCount === 2);

  round = 2;
  await import(`./guide-sitemap-monitor.mjs?s2round=2`);
  const known2 = JSON.parse(readFileSync(KNOWN, 'utf8'));
  expect('第二轮：分片 B 的 5 条 URL 现在补进 everSeenUrls', shardBUrls.every(u => known2.everSeenUrls.includes(u.loc)));
  expect('第二轮：分片 B 现在 bootstrap 完成', known2.bootstrappedShards['post-sitemap-2026-2.xml']?.bootstrapped === true);
  const events2 = readJsonl(NEWSEEN);
  const bBaseline = events2.filter(e => e.eventType === 'baseline' && e.url.includes('roblox-b'));
  const bFirstSeen = events2.filter(e => e.eventType === 'first_seen' && e.url.includes('roblox-b'));
  expect('分片 B 的 URL 在真正抓成功那一刻记 baseline（不是 first_seen）——即便站已经跑了第二轮', bBaseline.length === 5 && bFirstSeen.length === 0);
  const thgRuns2 = readJsonl(RUNS).filter(r => r.sourceKey === 'tryhardguides');
  expect('第二轮健康记录 ok（这轮只需要重抓分片 B，分片 A lastmod 没变）', thgRuns2[1].status === 'ok' && thgRuns2[1].fetchedCount === 1 && thgRuns2[1].eligibleCount === 1);
}

// ==================================================================================
// Suite 3（Beebom）：分片编号非时间序 —— 按 lastmod 变化挑分片，不是按编号；编号跳变要 warn
// ==================================================================================
{
  const tmp = freshDir('s3');
  process.env.GUIDE_STATE_DIR = tmp;
  const NEWSEEN = join(tmp, 'guide-newly-seen.jsonl');

  // shard1 = post-sitemap.xml（无编号，视为分片 1）——本次场景里它才是"实际更新"的分片
  // shard2 = post-sitemap2.xml（编号最高）——lastmod 一直不变，属于老内容
  const shard1UrlsV1 = [{ loc: 'https://beebom.com/roblox-x1-codes/', lastmod: '2026-01-01T00:00:00+00:00' }];
  const shard1UrlsV2 = [...shard1UrlsV1, { loc: 'https://beebom.com/roblox-x4-codes/', lastmod: '2026-07-12T00:00:00+00:00' }];
  const shard2Urls = [{ loc: 'https://beebom.com/roblox-y1-codes/', lastmod: '2015-01-01T00:00:00+00:00' }];
  // shard2 这份内容只在"如果被误抓"时才会暴露出来的新 URL——正确实现绝不应该抓到它
  const shard2UrlsIfWronglyRefetched = [...shard2Urls, { loc: 'https://beebom.com/roblox-y2-codes/', lastmod: '2015-01-01T00:00:00+00:00' }];

  let round = 1;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('beebom.com/sitemap_index.xml')) {
      const shard1Lastmod = round === 1 ? '2026-01-01T00:00:00+00:00' : '2026-07-12T00:00:00+00:00';
      return text(indexXml([
        { loc: 'https://beebom.com/post-sitemap.xml', lastmod: shard1Lastmod },
        { loc: 'https://beebom.com/post-sitemap2.xml', lastmod: '2015-01-01T00:00:00+00:00' }, // 编号最高，lastmod 一直最旧
      ]));
    }
    if (u === 'https://beebom.com/post-sitemap.xml') return text(urlsetXml(round === 1 ? shard1UrlsV1 : shard1UrlsV2));
    if (u === 'https://beebom.com/post-sitemap2.xml') {
      // 如果实现错误地"按编号最高"重抓了这个分片，这里会暴露出 roblox-y2-codes；
      // 正确实现（按 lastmod 是否变化）在第二轮不该发起这个请求
      return text(urlsetXml(round === 1 ? shard2Urls : shard2UrlsIfWronglyRefetched));
    }
    if (u === 'https://beebom.com/roblox-x4-codes/') return text(articleHtml({ title: 'X4 Codes', placeId: null }));
    throw new Error('suite3 unexpected fetch: ' + u);
  };

  await import(`./guide-sitemap-monitor.mjs?s3round=1`);
  const events1 = readJsonl(NEWSEEN);
  expect('冷启动：两个分片各自的 baseline 都建立（1+1=2 条）', events1.length === 2);

  round = 2;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    await import(`./guide-sitemap-monitor.mjs?s3round=2`);
  } finally {
    console.warn = realWarn;
  }
  const events2 = readJsonl(NEWSEEN);
  const newEvents = events2.slice(2); // 跳过冷启动那 2 条
  expect('第二轮：只有分片 1（lastmod 变化）产生新事件', newEvents.length === 1 && newEvents[0]?.url === 'https://beebom.com/roblox-x4-codes/');
  expect('第二轮：编号最高的分片 2（lastmod 未变）没有被误抓——y2 不出现', !events2.some(e => e.url.includes('roblox-y2')));
  expect('第二轮：编号跳变触发健康 warning（不是失败，只是提示）', warnings.some(w => w.includes('beebom') && (w.includes('编号') || w.includes('分片规则'))));
}

// ==================================================================================
// Suite 4（Dexerto，轻量覆盖）：月度分片冷启动 + 当月新增
// ==================================================================================
{
  const tmp = freshDir('s4');
  process.env.GUIDE_STATE_DIR = tmp;
  const NEWSEEN = join(tmp, 'guide-newly-seen.jsonl');

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const curUrl = (yy, mm) => `https://www.dexerto.com/post-sitemap.xml?year=${yy}&month=${mm}`;

  const baseline = [{ loc: 'https://www.dexerto.com/roblox/old-game-codes-1/', lastmod: '2026-01-01T00:00:00.000Z' }];
  const NEW_URL = 'https://www.dexerto.com/roblox/new-game-codes-2/';

  let round = 1;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === curUrl(y, m)) return text(urlsetXml(round === 1 ? baseline : [...baseline, { loc: NEW_URL, lastmod: '2026-07-12T00:00:00.000Z' }]));
    if (u === curUrl(prevY, prevM)) return text(urlsetXml([]));
    if (u === NEW_URL) return text(articleHtml({ title: 'New Game Codes', placeId: null }));
    throw new Error('suite4 unexpected fetch: ' + u);
  };

  await import(`./guide-sitemap-monitor.mjs?s4round=1`);
  const events1 = readJsonl(NEWSEEN);
  expect('Dexerto 冷启动：当月 1 条 baseline，上月 0 条', events1.length === 1 && events1[0].eventType === 'baseline');

  round = 2;
  await import(`./guide-sitemap-monitor.mjs?s4round=2`);
  const events2 = readJsonl(NEWSEEN);
  const firstSeen = events2.filter(e => e.eventType === 'first_seen');
  expect('Dexerto 第二轮：当月新增 URL 产生 1 条 first_seen', firstSeen.length === 1 && firstSeen[0]?.url === NEW_URL);
}

console.log(failed ? `\n${failed} 条回归失败` : '\n回归全过');
process.exit(failed ? 1 : 0);
