import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILLER_BITS,
  formatFillerBitInstruction,
  formatWorkingNoteWithBit,
} from '../src/agent/bits.ts';
import { buildNudgeInstruction } from '../src/agent/nudge.ts';
import { ALICE_SYSTEM_PROMPT, GREETING_INSTRUCTIONS } from '../src/agent/prompt.ts';
import {
  FIRST_CHECKIN_INSTRUCTIONS,
  SECOND_CHECKIN_INSTRUCTIONS,
} from '../src/agent/silence.ts';
import {
  SLOW_TOOL_NOTES,
  TOOL_ERROR_FALLBACK,
  createAgentTools,
} from '../src/agent/tools.ts';

const BANNED_CORPORATE_PHRASES: readonly string[] = [
  'certainly',
  "I'd be happy to",
  'great choice',
  'absolutely',
  'perfect',
  'no problem',
  'let me know if',
  'I apologize',
  'is there anything else',
];

const REQUIRED_TOOLS = [
  'show_rack',
  'set_department',
  'build_outfits',
  'pick_outfit',
  'show_on_me',
  'add_to_bag',
  'remove_from_bag',
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

test('ALICE_SYSTEM_PROMPT word count is within 450 to 1380 words and avoids tables/emoji', () => {
  const words = countWords(ALICE_SYSTEM_PROMPT);
  assert.ok(words >= 450 && words <= 1380, `expected word count between 450 and 1380, got ${words}`);

  assert.equal(ALICE_SYSTEM_PROMPT.includes('|---'), false, 'prompt must not contain markdown tables');
  assert.equal(/\p{Extended_Pictographic}/u.test(ALICE_SYSTEM_PROMPT), false, 'prompt must not contain emoji');
  assert.equal(/(^|\n)#{1,6}\s/.test(ALICE_SYSTEM_PROMPT), false, 'prompt must not contain markdown headings');
  assert.equal(ALICE_SYSTEM_PROMPT.includes('**'), false, 'prompt must not contain markdown bold');
  assert.equal(ALICE_SYSTEM_PROMPT.includes('`'), false, 'prompt must not contain markdown backticks');
});

test('ALICE_SYSTEM_PROMPT encodes waiting, bag, camera-off try-on, and weather guidance', () => {
  // 1. Waiting on slow tools: never silent, tell bit in own words, stop on result / shopper speech.
  assert.match(ALICE_SYSTEM_PROMPT, /pulling looks together/i);
  assert.match(ALICE_SYSTEM_PROMPT, /at most one useful style question/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never leave silence while a slow tool works/i);
  assert.match(ALICE_SYSTEM_PROMPT, /tell the bit naturally in your own words/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never read it out word for word/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never claim anything is ready/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never describe looks, prices, or products/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never ask a question that needs an answer/i);
  assert.match(ALICE_SYSTEM_PROMPT, /if the shopper talks during a bit, stop and answer them/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never return to an unfinished bit/i);
  assert.match(ALICE_SYSTEM_PROMPT, /finish your sentence and switch cleanly/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never start a new bit after a result arrives/i);
  assert.doesNotMatch(ALICE_SYSTEM_PROMPT, /stay quiet until/i);
  assert.doesNotMatch(ALICE_SYSTEM_PROMPT, /no small talk|never fill silence with small talk/i);

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

test('ALICE_SYSTEM_PROMPT encodes polish2 rules: bag accuracy, size confirmation, pick brevity, and noisy-room handling', () => {
  // 1. Conditional show_on_me sizing.
  assert.match(ALICE_SYSTEM_PROMPT, /already have all sizes needed/i);
  assert.match(ALICE_SYSTEM_PROMPT, /ask only for the missing sizes/i);

  // 2. Accuracy rule for bag items.
  assert.match(
    ALICE_SYSTEM_PROMPT,
    /only say a piece is in the bag if the latest add_to_bag result lists it as added/i,
  );
  assert.match(ALICE_SYSTEM_PROMPT, /PARTLY DONE/);
  assert.match(ALICE_SYSTEM_PROMPT, /never say a not-added piece is in the bag/i);

  // 3. Noisy-room size confirmation, exact formats, conflicting sets, and corrections.
  assert.match(ALICE_SYSTEM_PROMPT, /repeat the sizes back in one short clause/i);
  assert.match(ALICE_SYSTEM_PROMPT, /two different sets of sizes/i);
  assert.match(ALICE_SYSTEM_PROMPT, /8\.5 wide/i);
  assert.match(ALICE_SYSTEM_PROMPT, /30x34/i);
  assert.match(ALICE_SYSTEM_PROMPT, /later explicit correction.*replaces the remembered size/i);

  // 4. pick_outfit hero pieces brevity (~10s, 1-2 hero pieces, no full listing, never invent materials).
  assert.match(ALICE_SYSTEM_PROMPT, /one line naming the look's idea/i);
  assert.match(ALICE_SYSTEM_PROMPT, /one or two hero pieces/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never invent materials/i);
  assert.match(ALICE_SYSTEM_PROMPT, /do not list the other pieces/i);
  assert.match(ALICE_SYSTEM_PROMPT, /~10s total/i);
  assert.doesNotMatch(ALICE_SYSTEM_PROMPT, /four or five sentences/i);

  // 5. Tightened opening (under 3 minutes): one-sentence look check, step back only if no clothing visible, occasion + budget in one question.
  assert.match(ALICE_SYSTEM_PROMPT, /check their look in ONE sentence/i);
  assert.match(ALICE_SYSTEM_PROMPT, /ask to step back only if you can see no clothing at all/i);
  assert.match(
    ALICE_SYSTEM_PROMPT,
    /occasion and budget in ONE question \("what's the occasion and what's the budget\?"\)/i,
  );
  assert.match(ALICE_SYSTEM_PROMPT, /hold the sizes question until the last beat finishes/i);

  // 5. General noisy-room rule.
  assert.match(ALICE_SYSTEM_PROMPT, /fragment that does not fit the conversation/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never|do not respond.*call a tool on it/i);
  assert.match(ALICE_SYSTEM_PROMPT, /Was that for me\?/i);
  assert.match(ALICE_SYSTEM_PROMPT, /at most once/i);
});

test('ALICE_SYSTEM_PROMPT encodes polish3 rules: interruption recovery, surprise reveal, and top/bottom/shoe sizes only', () => {
  // 1. Interruption handling.
  assert.match(ALICE_SYSTEM_PROMPT, /stop talking the moment the shopper speaks/i);
  assert.match(ALICE_SYSTEM_PROMPT, /without restarting the sentence or apologising/i);
  assert.match(ALICE_SYSTEM_PROMPT, /answer that first, then return to your earlier thought only if it still matters/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never repeat a line you already finished/i);

  // 2. Surprise reveal build-up and no pre-reveal description.
  assert.match(ALICE_SYSTEM_PROMPT, /reveal as a surprise/i);
  assert.match(ALICE_SYSTEM_PROMPT, /one short line of build-up/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never describe the try-on image before the result says it is revealed/i);

  // 3. Only ask for top, bottom, and shoe sizes (never jacket, belt, or accessory sizes).
  assert.match(ALICE_SYSTEM_PROMPT, /ask only for top, bottom, and shoe sizes/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never for jacket, belt, or accessory sizes/i);
  assert.match(ALICE_SYSTEM_PROMPT, /matched the jacket to their top size or the belt to their waist/i);
});

test('ALICE_SYSTEM_PROMPT encodes polish4 rules: single build, immediate bag confirmation, no repeated questions, critic swap, and $10,000 cap', () => {
  // 1. Rebuild only when asked for different looks or occasion/budget changes; passing style remarks handled via presenting or swap_piece.
  assert.match(ALICE_SYSTEM_PROMPT, /once looks are on screen.*different looks/i);
  assert.match(ALICE_SYSTEM_PROMPT, /passing style remarks.*swap_piece/i);

  // 2. Say sizes once as calling add_to_bag (never after it returns) and confirm bag straight away.
  assert.match(ALICE_SYSTEM_PROMPT, /repeat the sizes back in one short clause once as you call it/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never after it returns/i);
  assert.match(ALICE_SYSTEM_PROMPT, /state plainly what is in the bag and the total straight away/i);

  // 3. Never repeat a question just asked.
  assert.match(ALICE_SYSTEM_PROMPT, /never repeat a line you already finished or a question you just asked/i);

  // 4. Offer once to swap weak piece without mentioning scores or a critic.
  assert.match(ALICE_SYSTEM_PROMPT, /weak piece.*offer once to swap it/i);
  assert.match(ALICE_SYSTEM_PROMPT, /without mentioning scores or a critic/i);

  // 5. Budget and bag $10,000 cap.
  assert.match(ALICE_SYSTEM_PROMPT, /cap budgets and bags over \$10,000/i);

  // 6. Three-beat reveal guidance (studio shot, on-location shot, short video).
  assert.match(ALICE_SYSTEM_PROMPT, /up to three beats.*studio shot.*on-location shot.*short video/i);
  assert.match(ALICE_SYSTEM_PROMPT, /react to each in one line only when a tool result or note says it landed/i);
});

test('ALICE_SYSTEM_PROMPT encodes polish6 voice: NY stylist attitude, slang limits, delivery, opinions, budgets, and body/appearance boundary', () => {
  // 1. NY stylist persona, sass, and vocal delivery.
  assert.match(ALICE_SYSTEM_PROMPT, /sass, not sweetness/i);
  assert.match(ALICE_SYSTEM_PROMPT, /millennial New Yorker/i);
  assert.match(ALICE_SYSTEM_PROMPT, /at most one slang phrase per reply/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never twice in a row/i);
  assert.match(ALICE_SYSTEM_PROMPT, /expressive, animated, fast New York delivery/i);
  assert.match(ALICE_SYSTEM_PROMPT, /real laughs/i);

  // 2. Body/appearance limit still clearly stated (roast clothes, never people).
  assert.match(ALICE_SYSTEM_PROMPT, /roast clothes, never people/i);
  assert.match(ALICE_SYSTEM_PROMPT, /\bbody\b/i);
  assert.match(ALICE_SYSTEM_PROMPT, /\bweight\b/i);
  assert.match(ALICE_SYSTEM_PROMPT, /\bface\b/i);
  assert.match(ALICE_SYSTEM_PROMPT, /\bage\b/i);
  assert.match(ALICE_SYSTEM_PROMPT, /\bskin\b/i);

  // 3. First-look critique with score out of ten, roast with teeth, win, upgrade.
  assert.match(ALICE_SYSTEM_PROMPT, /score out of ten/i);
  assert.match(ALICE_SYSTEM_PROMPT, /roast with teeth/i);
  assert.match(ALICE_SYSTEM_PROMPT, /one honest win/i);

  // 4. Opinions on looks and budget attitude.
  assert.match(ALICE_SYSTEM_PROMPT, /favourite/i);
  assert.match(ALICE_SYSTEM_PROMPT, /push back once/i);
  assert.match(ALICE_SYSTEM_PROMPT, /budget compromises?/i);
  assert.match(ALICE_SYSTEM_PROMPT, /small budgets/i);
  assert.match(ALICE_SYSTEM_PROMPT, /eyebrow/i);

  // 5. Bag what can be bagged immediately without holding back over one missing/unavailable piece.
  assert.match(ALICE_SYSTEM_PROMPT, /call add_to_bag straight away with every known size/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never hold back the whole bag/i);
});

test('ALICE_SYSTEM_PROMPT enforces add_to_bag stop-before-result and immediate re-bag on missing size', () => {
  assert.match(ALICE_SYSTEM_PROMPT, /STOP and say nothing else until the tool result arrives/);
  assert.match(ALICE_SYSTEM_PROMPT, /never state what is in the bag/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never state a total/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never read out anything that looks like a tool call or tool output before the result/i);
  assert.match(ALICE_SYSTEM_PROMPT, /what is in the bag and the total come only from the result text/i);
  assert.match(
    ALICE_SYSTEM_PROMPT,
    /when the shopper gives a missing size after PARTLY DONE or NOT DONE, call add_to_bag again immediately with all known sizes, no question first/i,
  );
  assert.match(
    ALICE_SYSTEM_PROMPT,
    /after swap_piece on a bagged look, call add_to_bag again—never say it is in the bag or give a bag total until add_to_bag returns/i,
  );
});

test('ALICE_SYSTEM_PROMPT encodes opening rack flow: one-sentence read, show_rack, no new arrivals claim, and occasion vs item fork', () => {
  assert.match(ALICE_SYSTEM_PROMPT, /one sentence.*what they are wearing/i);
  assert.match(ALICE_SYSTEM_PROMPT, /in the same turn call show_rack/i);
  assert.match(ALICE_SYSTEM_PROMPT, /pulled a few things off the racks that go with what they have on/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never claim new arrivals or just in/i);
  assert.match(ALICE_SYSTEM_PROMPT, /dressing for an occasion or looking for one specific item\?/i);
  assert.match(ALICE_SYSTEM_PROMPT, /camera off or cannot see them: skip the rack/i);
  assert.match(ALICE_SYSTEM_PROMPT, /specific item: use search_products/i);
});

test('ALICE_SYSTEM_PROMPT encodes polish10 rules: remove_from_bag, pick-based swaps, and loud-room silence', () => {
  assert.match(ALICE_SYSTEM_PROMPT, /remove_from_bag.*what is left and the new total from the result, never before it/i);
  assert.match(ALICE_SYSTEM_PROMPT, /search_products.*ONE specific result.*swap_piece with pick/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never recommend a product not from a tool result/i);
  assert.match(ALICE_SYSTEM_PROMPT, /unclear or background noise, stay silent and wait/i);
  assert.match(ALICE_SYSTEM_PROMPT, /never say audio was garbled/i);
  assert.match(ALICE_SYSTEM_PROMPT, /at most once in a row/i);
});

test('banned corporate phrases never appear in prompt, greeting, filler bits, silence check-ins, nudges, or tool result texts', () => {
  const toolSource = fs.readFileSync(new URL('../src/agent/tools.ts', import.meta.url), 'utf8');
  const sampleBit = FILLER_BITS[0]!;

  const surfaces: Array<{ label: string; text: string }> = [
    { label: 'ALICE_SYSTEM_PROMPT', text: ALICE_SYSTEM_PROMPT },
    { label: 'GREETING_INSTRUCTIONS', text: GREETING_INSTRUCTIONS },
    ...FILLER_BITS.map((bit) => ({ label: `FILLER_BITS[${bit.id}]`, text: `${bit.title} ${bit.text}` })),
    {
      label: 'formatWorkingNoteWithBit',
      text: formatWorkingNoteWithBit(SLOW_TOOL_NOTES.build_outfits!, sampleBit),
    },
    {
      label: 'formatFillerBitInstruction',
      text: formatFillerBitInstruction('build_outfits', sampleBit),
    },
    ...FIRST_CHECKIN_INSTRUCTIONS.map((text, idx) => ({
      label: `FIRST_CHECKIN_INSTRUCTIONS[${idx}]`,
      text,
    })),
    ...SECOND_CHECKIN_INSTRUCTIONS.map((text, idx) => ({
      label: `SECOND_CHECKIN_INSTRUCTIONS[${idx}]`,
      text,
    })),
    {
      label: 'nudge:build_outfits',
      text: buildNudgeInstruction('build_outfits', 'Built 3 looks and they are now on screen.') ?? '',
    },
    {
      label: 'nudge:show_on_me',
      text: buildNudgeInstruction('show_on_me', 'Try-on for Look 1 is now revealed on screen.') ?? '',
    },
    {
      label: 'nudge:add_to_bag',
      text: buildNudgeInstruction('add_to_bag', 'Added 3 pieces, total $160.') ?? '',
    },
    ...Object.entries(SLOW_TOOL_NOTES).map(([k, text]) => ({
      label: `SLOW_TOOL_NOTES[${k}]`,
      text,
    })),
    { label: 'TOOL_ERROR_FALLBACK', text: TOOL_ERROR_FALLBACK },
    { label: 'src/agent/tools.ts', text: toolSource },
  ];

  for (const { label, text } of surfaces) {
    for (const phrase of BANNED_CORPORATE_PHRASES) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${escaped}\\b`, 'i'),
        `banned corporate phrase "${phrase}" must not appear in ${label}`,
      );
    }
  }
});
