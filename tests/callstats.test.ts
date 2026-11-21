import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeCallStatsFromText,
  isSkippedRoom,
  runCli,
  type AllCallsStats,
  type CallStats,
} from '../scripts/callstats.ts';

function jsonl(records: Array<Record<string, unknown> | string>): string {
  const baseMs = Date.parse('2026-11-21T16:00:00.000Z');
  return (
    records
      .map((rec) => {
        if (typeof rec === 'string') return rec;
        const ms = typeof rec.ms === 'number' ? rec.ms : 0;
        return JSON.stringify({
          t: rec.t ?? new Date(baseMs + ms).toISOString(),
          pid: 1234,
          ...rec,
        });
      })
      .join('\n') + '\n'
  );
}

const FIXTURE_CALL_A = jsonl([
  { ms: 0, ev: 'job_start' },
  // Shopper turn 1: stops speaking at 1000, Alice speaks at 1800 (800ms)
  { ms: 400, ev: 'user_state', old: 'listening', state: 'speaking' },
  { ms: 1000, ev: 'user_state', old: 'speaking', state: 'listening' },
  { ms: 1100, ev: 'user_said', text: 'I need a dinner look in Soho.' },
  { ms: 1800, ev: 'agent_state', old: 'listening', state: 'speaking' },
  // Alice gets cut off at 3000 -> speaks again at 4500 (recovery 1500ms)
  { ms: 3000, ev: 'alice_said', text: 'Got it, let me—', interrupted: true },
  { ms: 3050, ev: 'agent_state', old: 'speaking', state: 'listening' },
  { ms: 3200, ev: 'false_interruption', resumed: true },
  { ms: 3500, ev: 'user_state', old: 'listening', state: 'speaking' },
  { ms: 4100, ev: 'user_state', old: 'speaking', state: 'listening' },
  { ms: 4150, ev: 'user_said', text: 'Budget is 300 dollars.' },
  // Response latency turn 2: 4500 - 4100 = 400ms
  { ms: 4500, ev: 'agent_state', old: 'listening', state: 'speaking' },
  { ms: 5000, ev: 'tool_call', name: 'build_outfits', call_id: 'c1' },
  { ms: 5200, ev: 'alice_said', text: 'Pulling three looks now.', interrupted: false },
  { ms: 5500, ev: 'agent_state', old: 'speaking', state: 'listening' },
  // Silence while build_outfits runs: 5500 -> 14500 = 9000ms
  { ms: 5600, ev: 'build_start', mode: 'live' },
  { ms: 6000, ev: 'store_search', query: 'blazer', source: 'live', n: 5, duration_ms: 420 },
  { ms: 6300, ev: 'store_search', query: 'trousers', source: 'saved', n: 4, duration_ms: 10 },
  { ms: 6500, ev: 'store_search', query: 'loafers', source: 'saved-near', n: 3, duration_ms: 20 },
  { ms: 6700, ev: 'store_search', query: 'belt', source: 'empty', n: 0, duration_ms: 300 },
  { ms: 7200, ev: 'media_shot', slot: 'top', source: 'product-only', duration_ms: 500 },
  { ms: 7500, ev: 'media_shot', slot: 'bottom', source: 'cropped', duration_ms: 700 },
  { ms: 7700, ev: 'media_shot', slot: 'shoes', source: 'original', duration_ms: 100 },
  { ms: 8600, ev: 'build_outfit', number: 1, build_ms: 3000 }, // 8600 - 5600 = 3000ms
  { ms: 9200, ev: 'media_board', outfit: 1, ok: true, duration_ms: 1200 },
  { ms: 10400, ev: 'media_board', outfit: 2, ok: false, duration_ms: 800 },
  { ms: 13600, ev: 'build_done', mode: 'live', outfits: 3, timing: { first_outfit_ms: 3000, total_ms: 8000 } },
  // Duplicate build_done from tools.ts should be ignored
  { ms: 13650, ev: 'build_done', source: 'live', timing: { first_outfit_ms: 3000, total_ms: 8000 } },
  { ms: 14500, ev: 'tool_result', name: 'build_outfits', call_id: 'c1', duration_ms: 9500 },
  { ms: 14700, ev: 'agent_state', old: 'listening', state: 'speaking' },
  { ms: 16000, ev: 'alice_said', text: 'Look one is sharp, look two is relaxed.', interrupted: false },
  { ms: 16100, ev: 'agent_state', old: 'speaking', state: 'listening' },
  // Shopper turn 3: ends 17000, Alice speaks at 18200 (1200ms)
  { ms: 16500, ev: 'user_state', old: 'listening', state: 'speaking' },
  { ms: 17000, ev: 'user_state', old: 'speaking', state: 'listening' },
  { ms: 17050, ev: 'user_said', text: 'Try look one on me.' },
  { ms: 18200, ev: 'agent_state', old: 'listening', state: 'speaking' },
  { ms: 18800, ev: 'alice_said', text: 'Rendering—', interrupted: true },
  { ms: 18850, ev: 'agent_state', old: 'speaking', state: 'listening' },
  // Second cut-off -> speaks again at 19350 (recovery 550ms)
  { ms: 19350, ev: 'agent_state', old: 'listening', state: 'speaking' },
  { ms: 19500, ev: 'alice_said', text: 'Rendering look one now.', interrupted: false },
  { ms: 19600, ev: 'agent_state', old: 'speaking', state: 'listening' },
  // Try-ons: 1 fails, 2nd succeeds after 1 redo check, 3rd passes first time
  { ms: 20000, ev: 'tryon_start', outfit: 1, pieces: 3 },
  { ms: 24000, ev: 'tryon_fail', outfit: 1, error: 'timeout', duration_ms: 4000 },
  { ms: 25000, ev: 'tryon_start', outfit: 1, pieces: 3 },
  { ms: 33000, ev: 'tryon_ready', outfit: 1, duration_ms: 8000 },
  { ms: 33500, ev: 'tryon_check', outfit: 1, attempt: 1, pass: false },
  { ms: 35000, ev: 'tryon_check', outfit: 1, attempt: 2, pass: true },
  { ms: 36000, ev: 'tryon_start', outfit: 2, pieces: 3 },
  { ms: 46000, ev: 'tryon_ready', outfit: 2, duration_ms: 10000 },
  { ms: 46500, ev: 'tryon_check', outfit: 2, attempt: 1, pass: true },
  // Bag & bad events
  {
    ms: 48000,
    ev: 'store_bag',
    added: 2,
    not_added: 1,
    carts: 1,
    total_usd: 210,
    duration_ms: 650,
    reasons: ['size M out of stock'],
  },
  { ms: 49000, ev: 'tool_call', name: 'swap_piece', call_id: 'c2' },
  { ms: 49500, ev: 'tool_error', name: 'swap_piece', call_id: 'c2', error: 'boom' },
  { ms: 50000, ev: 'page_error', action: 'setBag', error: 'timeout' },
  { ms: 50500, ev: 'store_error', tool: 'search_shop_catalog', code: '429' },
  { ms: 51000, ev: 'media_process_exit', code: 1 },
  { ms: 51500, ev: 'restart', prev_pid: 1111 },
  // Malformed line should be ignored gracefully
  '{not valid json at all',
  'null',
]);

const FIXTURE_CALL_B = jsonl([
  { ms: 0, ev: 'job_start' },
  { ms: 1000, ev: 'user_said', text: 'Show me a jacket.' },
  { ms: 1500, ev: 'alice_said', text: 'Here you go.', interrupted: false },
  {
    ms: 5000,
    ev: 'store_bag',
    added: 3,
    not_added: 2,
    carts: 2,
    duration_ms: 450,
    reasons: ['size M out of stock', 'store did not answer'],
  },
  { ms: 10000, ev: 'session_close', reason: 'done' },
]);

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alice-callstats-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('callstats', () => {
  test('computes all conversation, outfit, media, bag, and bad-event metrics from fixture log', () => {
    const { stats } = computeCallStatsFromText('demo-a', FIXTURE_CALL_A);

    assert.equal(stats.room, 'demo-a');
    assert.equal(stats.duration_ms, 51500);
    assert.equal(stats.malformed_lines, 2);

    // Conversation
    assert.equal(stats.conversation.shopper_turns, 3);
    assert.equal(stats.conversation.alice_turns, 5);
    assert.equal(stats.conversation.alice_interrupted, 2);
    assert.equal(stats.conversation.alice_interrupted_share, 0.4);
    assert.equal(stats.conversation.false_interruptions, 1);
    assert.deepEqual(stats.conversation.cutoff_recovery, {
      count: 2,
      median_ms: 1025, // median of [550, 1500]
      worst_ms: 1500,
    });
    assert.deepEqual(stats.conversation.response_latency, {
      count: 3,
      median_ms: 800, // [400, 800, 1200]
      p90_ms: 1200,
      worst_ms: 1200,
    });
    assert.equal(stats.conversation.longest_tool_silence_ms, 9000);
    assert.equal(stats.conversation.longest_tool_silence_tool, 'build_outfits');

    // Outfits & store
    assert.equal(stats.outfits.builds, 1);
    assert.deepEqual(stats.outfits.first_look, { count: 1, median_ms: 3000, worst_ms: 3000 });
    assert.deepEqual(stats.outfits.all_looks, { count: 1, median_ms: 8000, worst_ms: 8000 });
    assert.deepEqual(stats.outfits.store_searches, {
      count: 4,
      live: 1,
      saved: 2,
      saved_exact: 1,
      saved_near: 1,
      empty: 1,
      other: 0,
      median_ms: 160, // median of [10, 20, 300, 420]
    });
    assert.deepEqual(stats.outfits.errors_by_tool, { swap_piece: 1 });

    // Media
    assert.deepEqual(stats.media.shots, {
      count: 3,
      median_ms: 500, // median of [100, 500, 700]
      product_only: 1,
      cropped: 1,
      original: 1,
      other: 0,
    });
    assert.deepEqual(stats.media.boards, {
      count: 2,
      ok: 1,
      fail: 1,
      median_ms: 1000, // median of [800, 1200]
    });
    assert.deepEqual(stats.media.tryons, {
      count: 3,
      started: 3,
      ready: 2,
      failures: 1,
      median_ms: 9000, // median of [8000, 10000]
      worst_ms: 10000,
      checks: 3,
      passed_first_time: 1,
      redone: 1,
    });

    // Bag
    assert.deepEqual(stats.bag, {
      calls: 1,
      added: 2,
      not_added: 1,
      reasons: { 'size M out of stock': 1 },
      carts: 1,
      median_ms: 650,
      worst_ms: 650,
      total_ms: 650,
    });

    // Bad events
    assert.deepEqual(stats.bad, {
      tool_error: 1,
      page_error: 1,
      restart: 1,
      store_error: 1,
      tryon_fail: 1,
      media_process_exit: 1,
      total: 6,
    });
  });

  test('is defensive against empty logs, malformed lines, and missing fields', () => {
    const messy = [
      'not json',
      '{}',
      '{"ev": 123}',
      '{"ev": "alice_said"}',
      '{"ev": "store_search", "source": "live"}',
      '{"ev": "store_bag"}',
      '{"ev": "tryon_check", "ok": true, "redone": true}',
    ].join('\n');

    const { stats } = computeCallStatsFromText('messy-room', messy);
    assert.equal(stats.malformed_lines, 1);
    assert.equal(stats.duration_ms, null);
    assert.equal(stats.conversation.alice_turns, 1);
    assert.equal(stats.conversation.alice_interrupted, 0);
    assert.equal(stats.outfits.store_searches.count, 1);
    assert.equal(stats.outfits.store_searches.median_ms, null);
    assert.equal(stats.bag.calls, 1);
    assert.equal(stats.bag.added, 0);
    assert.equal(stats.media.tryons.redone, 1);
    assert.equal(stats.media.tryons.passed_first_time, 0);
  });

  test('tracks shopper response latency on both user_state transitions and user_said-only turns', () => {
    const mixed = jsonl([
      { ms: 0, ev: 'agent_state', old: 'initializing', state: 'listening' },
      // Normal turn: user_said without user_state speaking -> listening (900ms latency)
      { ms: 1000, ev: 'user_said', text: 'Budget is 500.' },
      { ms: 1900, ev: 'agent_state', old: 'listening', state: 'speaking' },
      // Late user_said while agent is speaking should not create a bogus pending turn
      { ms: 2100, ev: 'user_said', text: 'uh huh' },
      // Interruption with user_state speaking->listening + user_said 20ms later (600ms from user_state end)
      { ms: 3000, ev: 'user_state', old: 'listening', state: 'speaking' },
      { ms: 3010, ev: 'user_state', old: 'speaking', state: 'listening' },
      { ms: 3030, ev: 'user_said', text: 'Wait make it casual.' },
      { ms: 3050, ev: 'alice_said', text: 'Sure—', interrupted: true },
      { ms: 3060, ev: 'agent_state', old: 'speaking', state: 'listening' },
      { ms: 3610, ev: 'agent_state', old: 'listening', state: 'speaking' },
    ]);

    const { stats } = computeCallStatsFromText('mixed-turns', mixed);
    assert.deepEqual(stats.conversation.response_latency, {
      count: 2,
      median_ms: 750, // median of [600, 900]
      p90_ms: 900,
      worst_ms: 900,
    });
  });

  test('CLI supports single room, latest call, --all (skipping probe-* and _server), and --json', () => {
    assert.equal(isSkippedRoom('_server'), true);
    assert.equal(isSkippedRoom('probe-123'), true);
    assert.equal(isSkippedRoom('demo-a'), false);

    withTempDir((dir) => {
      const fileA = path.join(dir, 'demo-a.jsonl');
      const fileB = path.join(dir, 'demo-b.jsonl');
      const fileServer = path.join(dir, '_server.jsonl');
      const fileProbe = path.join(dir, 'probe-health.jsonl');

      writeFileSync(fileA, FIXTURE_CALL_A, 'utf8');
      writeFileSync(fileB, FIXTURE_CALL_B, 'utf8');
      writeFileSync(fileServer, '{"ms":0,"ev":"server_start"}\n', 'utf8');
      writeFileSync(fileProbe, '{"ms":0,"ev":"probe"}\n', 'utf8');

      // Make demo-b newer than demo-a, and _server newest (must be skipped for latest)
      const nowSec = Date.now() / 1000;
      utimesSync(fileA, nowSec - 20, nowSec - 20);
      utimesSync(fileB, nowSec - 10, nowSec - 10);
      utimesSync(fileServer, nowSec, nowSec);
      utimesSync(fileProbe, nowSec, nowSec);

      // Latest call -> demo-b (skipping _server and probe-health)
      const latest = runCli(['--json'], dir);
      assert.equal(latest.exitCode, 0);
      const latestJson = JSON.parse(latest.output) as CallStats;
      assert.equal(latestJson.room, 'demo-b');
      assert.equal(latestJson.conversation.response_latency.median_ms, 500);

      // Specific room text table
      const singleText = runCli(['demo-a'], dir);
      assert.equal(singleText.exitCode, 0);
      assert.match(singleText.output, /Call: demo-a/);
      assert.match(singleText.output, /Longest tool silence\s+9\.0s/);
      assert.match(singleText.output, /swap_piece \(1\)/);
      assert.match(singleText.output, /size M out of stock \(1\)/);

      // --all JSON skips _server and probe-health and aggregates totals
      const allJsonRes = runCli(['--all', '--json'], dir);
      assert.equal(allJsonRes.exitCode, 0);
      const allJson = JSON.parse(allJsonRes.output) as AllCallsStats;
      assert.deepEqual(
        allJson.calls.map((c) => c.room),
        ['demo-a', 'demo-b'],
      );
      assert.equal(allJson.totals.conversation.shopper_turns, 4);
      assert.equal(allJson.totals.conversation.alice_turns, 6);
      assert.equal(allJson.totals.bag.calls, 2);
      assert.equal(allJson.totals.bag.added, 5);
      assert.equal(allJson.totals.bag.not_added, 3);
      assert.deepEqual(allJson.totals.bag.reasons, {
        'size M out of stock': 2,
        'store did not answer': 1,
      });
      assert.equal(allJson.totals.bad.total, 6);

      // --all text table includes both calls and TOTAL row
      const allTextRes = runCli(['--all'], dir);
      assert.equal(allTextRes.exitCode, 0);
      assert.match(allTextRes.output, /demo-a/);
      assert.match(allTextRes.output, /demo-b/);
      assert.match(allTextRes.output, /TOTAL \(2 calls\)/);
      assert.doesNotMatch(allTextRes.output, /probe-health/);
      assert.doesNotMatch(allTextRes.output, /_server/);
    });
  });
});
