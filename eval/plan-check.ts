// Task check for the planner: plans five varied briefs live and checks each plan is valid and on-brief.
// Run: node --env-file=.env.local eval/plan-check.ts   (about 5-10 stylist calls, well under $0.10)
import type { Brief } from '../src/types.ts';
import { planOutfits, pieceCeiling, type Plan } from '../src/brain/plan.ts';

const BRIEFS: Brief[] = [
  { gender: 'men', occasion: "a friend's rooftop birthday", budget_usd: 150 },
  { gender: 'women', occasion: 'outdoor summer wedding guest', budget_usd: 150 },
  { gender: 'women', occasion: 'job interview at a bank', budget_usd: 180 },
  { gender: 'men', occasion: 'black tie optional gala', budget_usd: 250 },
  { gender: 'men', occasion: 'Sunday brunch', budget_usd: 120, own_piece: 'light blue denim jacket' },
];

function check(brief: Brief, plan: Plan): string[] {
  const issues: string[] = [];
  const dept = brief.gender === 'women' ? "women's" : "men's";
  if (plan.ideas.length < 3) issues.push(`only ${plan.ideas.length} ideas`);
  for (const [i, idea] of plan.ideas.entries()) {
    const at = `idea ${i + 1}`;
    const slots = idea.slots.map((s) => s.slot);
    const all = idea.slots.filter((s) => !s.own).map((s) => s.query.toLowerCase()).join(' | ');
    if (new Set(slots).size !== slots.length) issues.push(`${at}: repeated slot`);
    if (!slots.includes('shoes')) issues.push(`${at}: no shoes`);
    if (!slots.includes('dress') && !(slots.includes('top') && slots.includes('bottom'))) issues.push(`${at}: no top+bottom or dress`);
    if (!slots.some((s) => ['accessory', 'bag', 'jewelry'].includes(s))) issues.push(`${at}: no accessory`);
    if (idea.slots.some((s) => !s.own && !s.query.startsWith(dept))) issues.push(`${at}: a search is not ${dept}`);
    if (!idea.name || !idea.difference) issues.push(`${at}: missing name or difference`);
    if (/wedding/.test(brief.occasion) && /\b(white|ivory|bridal|bride)\b/.test(all)) issues.push(`${at}: white at a wedding`);
    if (/interview/.test(brief.occasion) && /\b(sandal|open toe|open-toe|mule|sheer|crop|lace)\w*/.test(all)) issues.push(`${at}: interview rule broken`);
    if (/black tie/.test(brief.occasion) && brief.gender === 'men') {
      if (!slots.includes('layer') || !slots.includes('bottom')) issues.push(`${at}: no suit jacket + trousers`);
      if (!/\btie\b/.test(all)) issues.push(`${at}: no tie`);
    }
    if (brief.own_piece && !idea.slots.some((s) => s.own)) issues.push(`${at}: own piece missing`);
  }
  return issues;
}

let failures = 0;
for (const brief of BRIEFS) {
  try {
    const plan = await planOutfits(brief);
    const issues = check(brief, plan);
    if (issues.length) failures++;
    console.log(`\n${issues.length ? 'FAIL' : 'PASS'}  ${brief.gender} · ${brief.occasion} · $${brief.budget_usd} (ceiling $${pieceCeiling(brief.budget_usd)})  [${plan.model}, ${plan.ms} ms, ${plan.repairs.length} repairs]`);
    for (const idea of plan.ideas) {
      console.log(`  ${idea.name}: ${idea.difference}`);
      for (const s of idea.slots) console.log(`     ${s.slot.padEnd(9)} ${s.own ? '(own) ' : ''}${s.query}`);
    }
    for (const r of plan.repairs) console.log(`  repair: ${r}`);
    for (const i of issues) console.log(`  !! ${i}`);
  } catch (err) {
    failures++;
    console.log(`\nFAIL  ${brief.occasion}: ${(err as Error).message}`);
  }
}
console.log(`\n${BRIEFS.length - failures}/${BRIEFS.length} plans valid and on-brief`);
process.exitCode = failures ? 1 : 0;
