#!/usr/bin/env node
// 离线回归：sitemap-monitor 的冷启动/diff/富化逻辑安全网。不碰真实网络、不碰真实 state。
// 两道必过题：
//   1. 冷启动只建基线，不产出 newly-seen 文件（"全部都是新的"没有信息量）
//   2. 第二轮出现新 placeId 时，被正确识别为新增，且 CCU/age 富化成功
// 跑法：node test-sitemap-regression.mjs；断言失败即非零退出。

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'sitemap-regression-'));
process.env.KNOWN_FILE = join(tmp, 'known.json');
process.env.NEWSEEN_FILE = join(tmp, 'newlyseen.jsonl');
process.env.RETRIES = '0';
process.env.TIMEOUT_MS = '2000';

const INDEX_XML = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://fake/shard1.xml</loc></sitemap><sitemap><loc>https://fake/shard2.xml</loc></sitemap></sitemapindex>`;
const SHARD1 = `<?xml version="1.0"?><urlset><url><loc>https://www.roblox.com/games/111/Old-Game</loc></url><url><loc>https://www.roblox.com/games/222/Another-Game</loc></url></urlset>`;
const SHARD2_V1 = `<?xml version="1.0"?><urlset><url><loc>https://www.roblox.com/games/333/Third-Game</loc></url></urlset>`;
// 第二轮：333 还在，新增 444
const SHARD2_V2 = `<?xml version="1.0"?><urlset><url><loc>https://www.roblox.com/games/333/Third-Game</loc></url><url><loc>https://www.roblox.com/games/444/New-Hot-Game</loc></url></urlset>`;

let round = 1;
const NEW_GAME = { id: 999, rootPlaceId: 444, name: 'New Hot Game', playing: 12345, created: new Date(Date.now() - 3 * 86400000).toISOString() };

const text = s => new Response(s, { status: 200 });
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('sitemap-games.xml')) return text(INDEX_XML);
  if (u.includes('shard1.xml')) return text(SHARD1);
  if (u.includes('shard2.xml')) return text(round === 1 ? SHARD2_V1 : SHARD2_V2);
  if (u.includes('/universes/v1/places/444/universe')) return json({ universeId: 999 });
  if (u.includes('games.roblox.com')) return json({ data: [NEW_GAME] });
  throw new Error('unexpected fetch in test: ' + u);
};

let failed = 0;
const expect = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed += 1; };

// ---- round 1: 冷启动 ----
await import(`./sitemap-monitor.mjs?round=1`);
const known1 = JSON.parse(readFileSync(process.env.KNOWN_FILE, 'utf8'));
expect('冷启动记录 3 个已知游戏', known1.placeIds.length === 3);
let newlySeenExistsAfterRound1 = true;
try { readFileSync(process.env.NEWSEEN_FILE, 'utf8'); } catch { newlySeenExistsAfterRound1 = false; }
expect('冷启动不产出 newly-seen 文件', !newlySeenExistsAfterRound1);

// ---- round 2: sitemap 出现新游戏 444 ----
round = 2;
await import(`./sitemap-monitor.mjs?round=2`);
const lines = readFileSync(process.env.NEWSEEN_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
expect('第二轮识别出 1 个新增', lines.length === 1);
expect('新增游戏 placeId 正确', lines[0]?.placeId === 444);
expect('新增游戏 CCU 富化成功', lines[0]?.playing === 12345);
expect('新增游戏 age 富化成功（约 3 天）', Math.abs((lines[0]?.ageDaysAtDiscovery ?? -99) - 3) < 0.5);
const known2 = JSON.parse(readFileSync(process.env.KNOWN_FILE, 'utf8'));
expect('第二轮已知集合更新为 4 个', known2.placeIds.length === 4);
expect('totalRuns 累加到 2', known2.totalRuns === 2);

console.log(failed ? `\n${failed} 条回归失败` : '\n回归全过');
process.exit(failed ? 1 : 0);
