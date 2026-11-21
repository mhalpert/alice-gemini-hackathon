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
});
