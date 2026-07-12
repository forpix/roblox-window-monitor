#!/usr/bin/env node
// 离线回归：sitemap-monitor 的冷启动/diff/富化逻辑安全网 + Part 0.2 的三个修复。
// 不碰真实网络、不碰真实 state。
//   1. 冷启动只建基线，不产出 newly-seen 文件（"全部都是新的"没有信息量）
//   2. 第二轮出现新 placeId 时，被正确识别为 first_seen，CCU/age 富化成功，健康记录 ok
//   3. 分片部分失败：非零退出码，known.json 不被残缺集合覆盖，健康记录 partial
//   4. 掉榜后重新上榜：产生 reentered（不是第二条 first_seen），everSeenPlaceIds 不重复计
// 跑法：node test-sitemap-regression.mjs；断言失败即非零退出。

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'sitemap-regression-'));
process.env.KNOWN_FILE = join(tmp, 'known.json');
process.env.NEWSEEN_FILE = join(tmp, 'newlyseen.jsonl');
process.env.RUNS_FILE = join(tmp, 'runs.jsonl');
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
  if (u.includes('shard2.xml')) {
    if (round === 3) return new Response('', { status: 500 }); // round3: 分片故障
    return text((round === 1 || round === 4) ? SHARD2_V1 : SHARD2_V2); // round4: 444 掉榜；round2/5: 444 在榜
  }
  if (u.includes('/universes/v1/places/444/universe')) return json({ universeId: 999 });
  if (u.includes('games.roblox.com')) return json({ data: [NEW_GAME] });
  throw new Error('unexpected fetch in test: ' + u);
};

let failed = 0;
const expect = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed += 1; };

// ---- round 1: 冷启动 ----
await import(`./sitemap-monitor.mjs?round=1`);
const known1 = JSON.parse(readFileSync(process.env.KNOWN_FILE, 'utf8'));
expect('冷启动记录 3 个已知游戏（currentPlaceIds）', known1.currentPlaceIds.length === 3);
expect('冷启动记录 3 个已知游戏（everSeenPlaceIds）', known1.everSeenPlaceIds.length === 3);
let newlySeenExistsAfterRound1 = true;
try { readFileSync(process.env.NEWSEEN_FILE, 'utf8'); } catch { newlySeenExistsAfterRound1 = false; }
expect('冷启动不产出 newly-seen 文件', !newlySeenExistsAfterRound1);

// ---- round 2: sitemap 出现新游戏 444 ----
round = 2;
await import(`./sitemap-monitor.mjs?round=2`);
const lines = readFileSync(process.env.NEWSEEN_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
expect('第二轮识别出 1 个新增', lines.length === 1);
expect('新增事件类型是 first_seen', lines[0]?.eventType === 'first_seen');
expect('新增游戏 placeId 正确', lines[0]?.placeId === 444);
expect('新增游戏 CCU 富化成功', lines[0]?.playing === 12345);
expect('新增游戏 age 富化成功（约 3 天）', Math.abs((lines[0]?.ageDaysAtDiscovery ?? -99) - 3) < 0.5);
const known2 = JSON.parse(readFileSync(process.env.KNOWN_FILE, 'utf8'));
expect('第二轮 currentPlaceIds 更新为 4 个', known2.currentPlaceIds.length === 4);
expect('第二轮 everSeenPlaceIds 累加为 4 个', known2.everSeenPlaceIds.length === 4);
expect('totalRuns 累加到 2', known2.totalRuns === 2);

const runs = readFileSync(process.env.RUNS_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
expect('两轮都产生 ok 健康记录', runs.length === 2 && runs.every(r => r.status === 'ok'));
expect('健康记录 sourceKey 正确', runs.every(r => r.sourceKey === 'roblox-sitemap'));
expect('健康记录分片数正确（2 个分片，2 个成功）', runs.every(r => r.fetchedCount === 2 && r.eligibleCount === 2));

// ---- round 3: 一个分片失败——不能用残缺集合覆盖基线，非零退出 ----
round = 3;
const priorKnown = readFileSync(process.env.KNOWN_FILE, 'utf8');
let round3ExitCode = null;
{
  const realExit = process.exit;
  // sitemap-monitor.mjs 用 process.exitCode（不调用 process.exit），這裡只是保险起见別讓意外的
  // exit 调用杀掉整个测试进程；同时读 process.exitCode 判断失败是否被正确标记。
  process.exit = (code) => { round3ExitCode = code; };
  process.exitCode = 0;
  try { await import(`./sitemap-monitor.mjs?round=3`); }
  finally { round3ExitCode = round3ExitCode ?? process.exitCode; process.exit = realExit; }
}
expect('分片部分失败：非零退出码', round3ExitCode === 1 || process.exitCode === 1);
process.exitCode = 0; // 复位，不让这次的失败测试污染最终的测试脚本退出码
const knownAfterRound3 = readFileSync(process.env.KNOWN_FILE, 'utf8');
expect('分片部分失败：known.json 未被覆盖（残缺集合不落盘）', knownAfterRound3 === priorKnown);
const runsAfterRound3 = readFileSync(process.env.RUNS_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
expect('分片部分失败：健康记录里有一条 partial', runsAfterRound3.some(r => r.status === 'partial'));

// ---- round 4: 恢复，且验证 reentered（444 掉榜后重新上榜，不是第二条 first_seen）----
round = 4;
await import(`./sitemap-monitor.mjs?round=4`); // SHARD2_V1（444 消失，回到只有 333）
round = 5;
await import(`./sitemap-monitor.mjs?round=5`); // SHARD2_V2（444 重新出现）
const linesAfter = readFileSync(process.env.NEWSEEN_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const reenteredLines = linesAfter.filter(l => l.placeId === 444 && l.eventType === 'reentered');
const firstSeenLines444 = linesAfter.filter(l => l.placeId === 444 && l.eventType === 'first_seen');
expect('444 重新上榜产生 reentered 事件', reenteredLines.length === 1);
expect('444 全程只有一条 first_seen（不是两条）', firstSeenLines444.length === 1);
const knownFinal = JSON.parse(readFileSync(process.env.KNOWN_FILE, 'utf8'));
expect('444 重新上榜后 everSeenPlaceIds 仍然只记一次', knownFinal.everSeenPlaceIds.filter(id => id === 444).length === 1);

console.log(failed ? `\n${failed} 条回归失败` : '\n回归全过');
process.exit(failed ? 1 : 0);
