const SLOW_DOWN_RE =
  /\b(?:take\s+(?:your|ur)\s+time|slow\s+(?:it\s+)?down|no\s+(?:rush|hurry)|not\s+(?:in\s+a\s+)?(?:rush|hurry)|don['’]?t\s+(?:rush|hurry)|do\s+not\s+(?:rush|hurry)|no\s+need\s+to\s+(?:rush|hurry)|plenty\s+of\s+time|exit\s+(?:express|turbo)|turn\s+off\s+(?:express|turbo)|normal\s+mode)\b/i;

const NEGATED_HURRY_RE =
  /\b(?:no|not|never|don['’]?t|do\s+not|without)\s+(?:in\s+a\s+)?(?:hurry|rush|rushing)\b/i;

const EXPRESS_FALSE_POSITIVE_RE =
  /\bamerican\s+express\b|\bexpress\s+(?:shipping|delivery|mail|myself|yourself|himself|herself|ourselves|themselves|my|your|our|their|feelings?|thoughts?|style)\b/i;

const HURRY_PATTERNS: readonly RegExp[] = [
  /\bin\s+a\s+(?:big\s+|real\s+)?hurry\b/i,
  /\bhurry\s+up\b/i,
  /\bin\s+a\s+(?:bit\s+of\s+a\s+|big\s+|real\s+)?rush\b/i,
  /\b(?:short|tight)\s+on\s+time\b/i,
  /\b(?:pressed|crunched)\s+for\s+time\b/i,
  /\brunning\s+late\b/i,
  /\b(?:make|keep)\s+(?:it|this)\s+(?:quick|fast|snappy|brief)\b/i,
  /\b(?:be\s+quick|quick\s+mode)\b/i,
  /\bturbo\b/i,
  /\b(?:speed\s+round|lightning\s+round|fast\s+mode)\b/i,
  /\b(?:only\s+(?:have|got)|got\s+like)\s+(?:a\s+|one\s+|two\s+|2\s+|few\s+|couple(?:\s+of)?\s+)?(?:min(?:ute)?s?|sec(?:ond)?s?)\b/i,
];

export const EXPRESS_ON_INSTRUCTION =
  'EXPRESS MODE ON: Say ONE short line that you are going express. From now on: no jokes, no waiting bits, no fun facts, no check on what they are wearing, and no rack talk; every turn is one sentence of at most 14 words. Ask only for what is still missing (occasion, budget, sizes for top, bottom, shoes) in ONE question—if they gave everything in one line, ask nothing. After build_outfits, name only your top pick in one sentence and call pick_outfit yourself without asking, then call show_on_me as soon as the try-on is ready without asking with one reaction line; scene and video beats still play with their lines only, no extra talk. Call add_to_bag at once when you have the sizes, and state the true bag result in one sentence.';

export const EXPRESS_OFF_INSTRUCTION =
  'EXPRESS MODE OFF: The shopper is not in a rush anymore. Return to normal Alice pacing and full New York stylist energy.';

/**
 * Pure detector for shopper turns indicating they are in a hurry / want express mode.
 * Returns false for negated phrases such as "no hurry", "no rush", "take your time",
 * and non-express phrases such as "express shipping" or "express myself".
 */
export function isHurryPhrase(text: string): boolean {
  if (typeof text !== 'string') return false;
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return false;
  if (SLOW_DOWN_RE.test(clean) || NEGATED_HURRY_RE.test(clean)) return false;

  for (const pattern of HURRY_PATTERNS) {
    if (pattern.test(clean)) return true;
  }

  if (/\bexpress\b/i.test(clean) && !EXPRESS_FALSE_POSITIVE_RE.test(clean)) {
    return true;
  }

  return false;
}

/**
 * Pure detector for shopper turns turning express mode off ("take your time",
 * "slow down", "no rush", "no hurry", etc.).
 */
export function isSlowDownPhrase(text: string): boolean {
  if (typeof text !== 'string') return false;
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return false;
  return SLOW_DOWN_RE.test(clean);
}
