import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALICE_SYSTEM_PROMPT, GREETING_INSTRUCTIONS } from '../src/agent/prompt.ts';
import { createAgentTools } from '../src/agent/tools.ts';

const REQUIRED_TOOLS = [
  'set_department',
  'build_outfits',
  'pick_outfit',
  'show_on_me',
  'add_to_bag',
  'swap_piece',
  'show_product',
  'hide_product',
  'show_all_looks',
  'search_products',
  'remember',
];

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

test('ALICE_SYSTEM_PROMPT and GREETING_INSTRUCTIONS are non-empty strings', () => {
  assert.equal(typeof ALICE_SYSTEM_PROMPT, 'string');
  assert.ok(ALICE_SYSTEM_PROMPT.trim().length > 0);

  assert.equal(typeof GREETING_INSTRUCTIONS, 'string');
  assert.ok(GREETING_INSTRUCTIONS.trim().length > 0);
  assert.equal(GREETING_INSTRUCTIONS.includes('\n'), false, 'GREETING_INSTRUCTIONS should be one short line');
});

test('ALICE_SYSTEM_PROMPT mentions every flow tool defined in tools.ts', () => {
  const definedTools = Object.keys(createAgentTools({ room: 'prompt-test', log: () => {} }));
  assert.deepEqual([...definedTools].sort(), [...REQUIRED_TOOLS].sort());

  for (const toolName of REQUIRED_TOOLS) {
    assert.match(
      ALICE_SYSTEM_PROMPT,
      new RegExp(`\\b${toolName}\\b`),
      `prompt must mention tool "${toolName}"`,
    );
  }
});

test('ALICE_SYSTEM_PROMPT mentions CALL STATE and CAMERA STATUS', () => {
  assert.match(ALICE_SYSTEM_PROMPT, /\bCALL STATE\b/);
  assert.match(ALICE_SYSTEM_PROMPT, /\bCAMERA STATUS\b/);
});

test('ALICE_SYSTEM_PROMPT word count is within 450 to 1100 words and avoids tables/emoji', () => {
  const words = countWords(ALICE_SYSTEM_PROMPT);
  assert.ok(words >= 450 && words <= 1100, `expected word count between 450 and 1100, got ${words}`);

  assert.equal(ALICE_SYSTEM_PROMPT.includes('|---'), false, 'prompt must not contain markdown tables');
  assert.equal(/\p{Extended_Pictographic}/u.test(ALICE_SYSTEM_PROMPT), false, 'prompt must not contain emoji');
  assert.equal(/(^|\n)#{1,6}\s/.test(ALICE_SYSTEM_PROMPT), false, 'prompt must not contain markdown headings');
  assert.equal(ALICE_SYSTEM_PROMPT.includes('**'), false, 'prompt must not contain markdown bold');
  assert.equal(ALICE_SYSTEM_PROMPT.includes('`'), false, 'prompt must not contain markdown backticks');
});

test('ALICE_SYSTEM_PROMPT encodes waiting, bag, camera-off try-on, and weather guidance', () => {
  // 1. Waiting on outfits: one short line, at most one useful style question, then stay quiet.
  assert.match(ALICE_SYSTEM_PROMPT, /pulling looks together/i);
  assert.match(ALICE_SYSTEM_PROMPT, /at most one useful style question/i);
  assert.match(ALICE_SYSTEM_PROMPT, /stay quiet until/i);
  assert.match(ALICE_SYSTEM_PROMPT, /no small talk|never fill silence with small talk/i);
  assert.doesNotMatch(ALICE_SYSTEM_PROMPT, /keep talking while it runs/i);
  assert.doesNotMatch(ALICE_SYSTEM_PROMPT, /keep the conversation moving/i);

  // 2. After add_to_bag: plain bag facts, never say processing, never pitch another look.
  assert.match(ALICE_SYSTEM_PROMPT, /state plainly what is in the bag and the total/i);
  assert.match(ALICE_SYSTEM_PROMPT, /each piece that was not added with its reason/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never say the bag is processing/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never pitch a different look/i);

  // 3. show_on_me with camera off: on screen on a model, turning camera on shows it on them.
  assert.match(ALICE_SYSTEM_PROMPT, /on screen on a model/i);
  assert.match(ALICE_SYSTEM_PROMPT, /turning the camera on lets you show it on them/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never that you cannot overlay it/i);

  // 4. Weather: mention in one short clause when known.
  assert.match(ALICE_SYSTEM_PROMPT, /mention the weather in one short clause when it is known/i);
});
