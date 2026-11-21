import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llm } from '@livekit/agents';
import {
  DUPLICATE_WINDOW_MS,
  TOOL_ERROR_FALLBACK,
  createAgentTools,
  createToolWrapper,
  stableStringify,
  type WorkingNoteParams,
} from '../src/agent/tools.ts';

interface RecordedLog {
  room: string;
  ev: string;
  data?: Record<string, unknown>;
}

test('createAgentTools builds 11 anonymous tools accepted by LiveKit ToolContext', () => {
  const tools = createAgentTools({ room: 'test-room', log: () => {}, slowDelayMs: 0 });
  const expectedNames = [
    'remember',
    'set_department',
    'build_outfits',
    'pick_outfit',
    'show_on_me',
    'swap_piece',
    'add_to_bag',
    'show_product',
    'hide_product',
    'show_all_looks',
    'search_products',
  ];

  assert.deepEqual(Object.keys(tools).sort(), [...expectedNames].sort());

  for (const [key, entry] of Object.entries(tools)) {
    assert.equal('name' in entry, false, `tool "${key}" must be anonymous (no name property)`);
    assert.equal('id' in entry, false, `tool "${key}" must be anonymous (no id property)`);
  }

  // Must not throw "tools object entry must be anonymous" when building ToolContext.
  const toolCtx = new llm.ToolContext(tools);
  assert.equal(Object.keys(toolCtx.functionTools).length, expectedNames.length);
  for (const name of expectedNames) {
    assert.equal(toolCtx.hasTool(name), true);
  }
});

test('duplicate-call guard returns the first promise within 15s and logs tool_duplicate', async () => {
  const logs: RecordedLog[] = [];
  let now = 1_000;
  let executions = 0;

  const wrapper = createToolWrapper({
    room: 'dup-room',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    now: () => now,
  });

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const fn = wrapper.wrap('pick_outfit', async (args: { outfit: number; note?: string }) => {
    executions++;
    if (executions === 1) {
      await firstGate;
    }
    return `picked ${args.outfit} (#${executions})`;
  });

  const p1 = fn({ outfit: 2, note: 'a' }, { toolCallId: 'call-1' });
  // Same args with different key insertion order within 15s window.
  now += 2_000;
  const p2 = fn({ note: 'a', outfit: 2 }, { toolCallId: 'call-2' });

  assert.strictEqual(p1, p2, 'duplicate call must return the exact first promise');

  releaseFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'picked 2 (#1)');
  assert.equal(r2, 'picked 2 (#1)');
  assert.equal(executions, 1);

  const dupLogs = logs.filter((l) => l.ev === 'tool_duplicate');
  assert.equal(dupLogs.length, 1);
  assert.equal(dupLogs[0]!.data?.call_id, 'call-2');
  assert.equal(dupLogs[0]!.data?.original_call_id, 'call-1');

  // After 15s window passes, identical call runs again.
  now += DUPLICATE_WINDOW_MS;
  const r3 = await fn({ outfit: 2, note: 'a' }, { toolCallId: 'call-3' });
  assert.equal(r3, 'picked 2 (#2)');
  assert.equal(executions, 2);
});

test('tool wrapper never throws, logs tool_error, and returns carry-on text', async () => {
  const logs: RecordedLog[] = [];
  const wrapper = createToolWrapper({
    room: 'err-room',
    log: (room, ev, data) => logs.push({ room, ev, data }),
  });

  const failing = wrapper.wrap('swap_piece', async () => {
    throw new Error('upstream store unavailable');
  });

  const result = await failing({ outfit: 1, slot: 'shoes', request: 'boots' }, { toolCallId: 'c-err' });
  assert.equal(result, TOOL_ERROR_FALLBACK);

  const errLog = logs.find((l) => l.ev === 'tool_error');
  assert.ok(errLog, 'must log tool_error');
  assert.equal(errLog!.data?.name, 'swap_piece');
  assert.equal(errLog!.data?.call_id, 'c-err');
  assert.ok(errLog!.data?.error instanceof Error);
  assert.equal((errLog!.data?.error as Error).message, 'upstream store unavailable');
  assert.equal(typeof errLog!.data?.stack, 'string');
});

test('slow tools send working notes immediately and build_outfits summarizes public/fixture.json', async () => {
  const logs: RecordedLog[] = [];
  const notes: WorkingNoteParams[] = [];
  const sleeps: number[] = [];

  const tools = createAgentTools({
    room: 'slow-room',
    log: (room, ev, data) => logs.push({ room, ev, data }),
    sendWorkingNote: (params) => {
      notes.push(params);
      return true;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    slowDelayMs: 2000,
  });

  const fakeOpts = { toolCallId: 'call-build', ctx: {} as never, abortSignal: new AbortController().signal };
  const summary = await tools.build_outfits.execute(
    { occasion: 'rooftop birthday', budget_usd: 150 },
    fakeOpts,
  );

  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 2000);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.name, 'build_outfits');
  assert.equal(notes[0]!.callId, 'call-build');

  assert.match(summary, /Look 1 — Skyline Knit \(\$104\.98\)/);
  assert.match(summary, /Look 2 — Warm Neutrals \(\$111\.96\)/);
  assert.match(summary, /Look 3 — After Dark \(\$99\.98\)/);

  assert.deepEqual(
    logs.map((l) => l.ev),
    ['tool_call', 'tool_note', 'tool_result'],
  );

  // Also check show_on_me and swap_piece trigger notes + delay.
  await tools.show_on_me.execute({ outfit: 1 }, { ...fakeOpts, toolCallId: 'call-tryon' });
  await tools.swap_piece.execute(
    { outfit: 2, slot: 'shoes', request: 'white sneakers' },
    { ...fakeOpts, toolCallId: 'call-swap' },
  );
  assert.deepEqual(
    notes.map((n) => n.name),
    ['build_outfits', 'show_on_me', 'swap_piece'],
  );
  assert.equal(sleeps.length, 3);
});

test('stableStringify produces identical output regardless of object key order', () => {
  assert.equal(
    stableStringify({ b: 2, a: { y: 1, x: 0 } }),
    stableStringify({ a: { x: 0, y: 1 }, b: 2 }),
  );
});
