import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallLogEntry } from '../scripts/calllog.ts';
import { evaluateCallLog } from '../scripts/harness/evaluate.ts';

function makePassingEvents(): CallLogEntry[] {
  return [
    { ms: 0, pid: 100, ev: 'token', identity: 'shopper-1', agent: 'alice' },
    { ms: 1200, pid: 200, ev: 'job_start' },
    { ms: 1205, pid: 200, ev: 'restart', prev_pid: 100 },
    { ms: 2000, pid: 200, ev: 'session_started', model: 'gemini-3.8-live' },
    { ms: 12500, pid: 200, ev: 'user_said', text: "Hi Alice, I'm Sam." },
    { ms: 14000, pid: 200, ev: 'alice_said', text: 'Hey Sam! What are we shopping for?' },
    {
      ms: 28000,
      pid: 200,
      ev: 'user_said',
      text: "I'm shopping menswear. It's for a rooftop birthday dinner this Saturday in New York, and my budget is three hundred dollars.",
    },
    { ms: 29000, pid: 200, ev: 'tool_call', name: 'set_department', args: { department: 'men' }, call_id: 'c1' },
    { ms: 29050, pid: 200, ev: 'tool_result', name: 'set_department', call_id: 'c1', text: 'Department set to men.' },
    { ms: 29200, pid: 200, ev: 'tool_call', name: 'build_outfits', args: { occasion: 'rooftop birthday dinner', budget_usd: 300 }, call_id: 'c2' },
    { ms: 29300, pid: 200, ev: 'tool_duplicate', name: 'build_outfits', args: { occasion: 'rooftop birthday dinner', budget_usd: 300 }, call_id: 'c2b', original_call_id: 'c2' },
    { ms: 32000, pid: 200, ev: 'build_progress', index: 0, name: 'Look 1', total: 240 },
    { ms: 32500, pid: 200, ev: 'page', action: 'showOutfits', reply: { ok: true } },
    { ms: 35000, pid: 200, ev: 'build_progress', index: 1, name: 'Look 2', total: 265 },
    { ms: 35400, pid: 200, ev: 'page', action: 'showOutfits', reply: { ok: true } },
    { ms: 38000, pid: 200, ev: 'build_progress', index: 2, name: 'Look 3', total: 280 },
    { ms: 38500, pid: 200, ev: 'page', action: 'showOutfits', reply: { ok: true } },
    { ms: 38600, pid: 200, ev: 'build_done', source: 'live' },
    { ms: 38700, pid: 200, ev: 'tool_result', name: 'build_outfits', call_id: 'c2', text: 'Built 3 looks.' },
    { ms: 46000, pid: 200, ev: 'page', action: 'tryOnReady', reply: { ok: true } },
    { ms: 46050, pid: 200, ev: 'tryon', outfit: 2, status: 'ready', url: '/tryon/tryon-1.jpg' },
    { ms: 75000, pid: 200, ev: 'user_said', text: 'I like the second one.' },
    { ms: 76200, pid: 200, ev: 'agent_state', old: 'listening', state: 'speaking' },
    { ms: 76500, pid: 200, ev: 'tool_call', name: 'pick_outfit', args: { outfit: 2 }, call_id: 'c3' },
    { ms: 76600, pid: 200, ev: 'page', action: 'highlight', reply: { ok: true } },
    { ms: 76650, pid: 200, ev: 'tool_result', name: 'pick_outfit', call_id: 'c3', text: 'Look 2 highlighted.' },
    { ms: 77000, pid: 200, ev: 'alice_said', text: 'Great choice, Look 2 is sharp.' },
    { ms: 105000, pid: 200, ev: 'user_said', text: 'Show me what it looks like on me.' },
    { ms: 106000, pid: 200, ev: 'tool_call', name: 'show_on_me', args: { outfit: 2 }, call_id: 'c4' },
    { ms: 106200, pid: 200, ev: 'page', action: 'reveal', reply: { ok: true } },
    { ms: 106250, pid: 200, ev: 'tool_result', name: 'show_on_me', call_id: 'c4', text: 'Try-on revealed.' },
    { ms: 140000, pid: 200, ev: 'user_said', text: 'Swap the shoes for brown boots.' },
    { ms: 141000, pid: 200, ev: 'tool_call', name: 'swap_piece', args: { outfit: 2, slot: 'shoes', request: 'brown boots' }, call_id: 'c5' },
    { ms: 144000, pid: 200, ev: 'swap', outfit: 2, slot: 'shoes', request: 'brown boots', title: 'Brown Suede Chelsea Boots', price: 89, store: 'Aldo', total: 279 },
    { ms: 144100, pid: 200, ev: 'tool_result', name: 'swap_piece', call_id: 'c5', text: 'Updated Look 2 on screen: shoes is now Brown Suede Chelsea Boots ($89, Aldo).' },
    { ms: 175000, pid: 200, ev: 'user_said', text: 'Tell me more about those boots.' },
    { ms: 176000, pid: 200, ev: 'tool_call', name: 'show_product', args: { outfit: 2, slot: 'shoes' }, call_id: 'c6' },
    { ms: 176200, pid: 200, ev: 'tool_result', name: 'show_product', call_id: 'c6', text: 'Showing product page.' },
    { ms: 200000, pid: 200, ev: 'user_said', text: 'Large in tops, size eleven shoes, bag it.' },
    { ms: 201000, pid: 200, ev: 'tool_call', name: 'add_to_bag', args: { outfit: 2, sizes: { top: 'L', shoes: '11' } }, call_id: 'c7a' },
    { ms: 201100, pid: 200, ev: 'tool_result', name: 'add_to_bag', call_id: 'c7a', text: 'NOT DONE: Still need sizes for: bottom. Ask for just those in one question, then call add_to_bag again.' },
    { ms: 202000, pid: 200, ev: 'alice_said', text: 'Got it, what waist size do you wear in pants?' },
    { ms: 225000, pid: 200, ev: 'user_said', text: 'A thirty four waist.' },
    { ms: 226000, pid: 200, ev: 'tool_call', name: 'add_to_bag', args: { outfit: 2, sizes: { bottom: '34' } }, call_id: 'c7b' },
    { ms: 227000, pid: 200, ev: 'page', action: 'bagReady', reply: { ok: true } },
    {
      ms: 227100,
      pid: 200,
      ev: 'bag',
      outfit: 2,
      stores: [{ store: 'Aldo', added: 3, not_added: 0, subtotal: 279 }],
      total: 279,
      not_added: [],
      mocked: false,
    },
    { ms: 227200, pid: 200, ev: 'tool_result', name: 'add_to_bag', call_id: 'c7b', text: 'Added 3 pieces, total $279.' },
    { ms: 228000, pid: 200, ev: 'alice_said', text: 'All three pieces are in your bag and your checkout link is on the page.' },
  ];
}

test('evaluateCallLog passes a clean call, ignores early restart and logged duplicates, and computes timings', () => {
  const report = evaluateCallLog(makePassingEvents());

  assert.equal(report.passed, true);
  assert.deepEqual(
    report.checks.filter((c) => !c.passed),
    [],
  );
  assert.equal(report.warnings.length, 0);
  assert.equal(report.duplicateToolCounts.build_outfits, 1);

  assert.equal(report.timings.occasionToFirstLookSec, 4.5);
  assert.equal(report.timings.occasionToAllThreeSec, 10.5);
  assert.equal(report.timings.occasionToTryOnReadySec, 18);
  assert.equal(report.timings.pickToFirstWordSec, 1.2);
});

test('evaluateCallLog fails when an expected tool runs more than once without deduplication', () => {
  const events = makePassingEvents();
  events.push({
    ms: 82000,
    pid: 200,
    ev: 'tool_call',
    name: 'pick_outfit',
    args: { outfit: 2 },
    call_id: 'c3-dup',
  });

  const report = evaluateCallLog(events);
  assert.equal(report.passed, false);
  const toolCheck = report.checks.find((c) => c.name === 'expected_tools');
  assert.ok(toolCheck && !toolCheck.passed);
  assert.match(toolCheck.detail, /pick_outfit \(2x\)/);
});

test('evaluateCallLog fails on a restart event after the first 5 seconds', () => {
  const events = makePassingEvents();
  events.push({ ms: 42000, pid: 300, ev: 'restart', prev_pid: 200 });

  const report = evaluateCallLog(events);
  assert.equal(report.passed, false);
  const restartCheck = report.checks.find((c) => c.name === 'no_late_restart');
  assert.ok(restartCheck && !restartCheck.passed);
  assert.match(restartCheck.detail, /42\.00s/);
});

test('evaluateCallLog fails when bagged sizes do not match what the shopper said', () => {
  const events = makePassingEvents().map((ev) => {
    if (ev.ev === 'tool_call' && ev.name === 'add_to_bag' && ev.call_id === 'c7b') {
      return { ...ev, args: { outfit: 2, sizes: { bottom: '32' } } };
    }
    return ev;
  });

  const report = evaluateCallLog(events);
  assert.equal(report.passed, false);
  const bagCheck = report.checks.find((c) => c.name === 'bag_sizes_and_items');
  assert.ok(bagCheck && !bagCheck.passed);
  assert.match(bagCheck.detail, /bottom size "32"/);
});

test('evaluateCallLog warns on stock not_added when Alice is honest and fails on a false bag claim', () => {
  const baseEvents = makePassingEvents().map((ev) => {
    if (ev.ev === 'bag') {
      return {
        ...ev,
        not_added: [
          {
            store: 'Aldo',
            title: 'Brown Suede Chelsea Boots',
            reason: "11 isn't in stock (sizes left: 9, 10)",
          },
        ],
      };
    }
    return ev;
  });

  // Honest disclosure: should pass with a stock warning.
  const honestEvents = baseEvents.map((ev) =>
    ev.ev === 'alice_said' && ev.ms === 228000
      ? {
          ...ev,
          text: "I added your top and trousers to the bag, but the Brown Suede Chelsea Boots weren't added because size 11 isn't in stock.",
        }
      : ev,
  );
  const honestReport = evaluateCallLog(honestEvents);
  assert.equal(honestReport.passed, true);
  assert.equal(honestReport.warnings.length, 1);
  assert.match(honestReport.warnings[0]!, /Brown Suede Chelsea Boots/);

  // False claim naming the skipped piece as in the bag: should fail.
  const falsePieceEvents = baseEvents.map((ev) =>
    ev.ev === 'alice_said' && ev.ms === 228000
      ? {
          ...ev,
          text: 'Your shirt, pants, and the Brown Suede Chelsea Boots are in your bag and ready for checkout.',
        }
      : ev,
  );
  const falsePieceReport = evaluateCallLog(falsePieceEvents);
  assert.equal(falsePieceReport.passed, false);
  const claimCheck = falsePieceReport.checks.find((c) => c.name === 'no_false_bag_claim');
  assert.ok(claimCheck && !claimCheck.passed);
  assert.match(claimCheck.detail, /Brown Suede Chelsea Boots/);

  // Blanket claim ("All three pieces are in your bag"): also fails.
  const blanketReport = evaluateCallLog(baseEvents);
  assert.equal(blanketReport.passed, false);
  const blanketCheck = blanketReport.checks.find((c) => c.name === 'no_false_bag_claim');
  assert.ok(blanketCheck && !blanketCheck.passed);
});

test('evaluateCallLog fails on page_error and non-brown shoe swaps', () => {
  const events = makePassingEvents().map((ev) =>
    ev.ev === 'swap' ? { ...ev, title: 'Black Leather Derby Shoes' } : ev,
  );
  events.push({ ms: 50000, pid: 200, ev: 'page_error', action: 'showOutfits', error: 'rpc timeout' });

  const report = evaluateCallLog(events);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((c) => c.name === 'no_page_error')?.passed, false);
  assert.equal(report.checks.find((c) => c.name === 'no_error_events')?.passed, false);
  assert.equal(report.checks.find((c) => c.name === 'swap_brown_shoes')?.passed, false);
});
