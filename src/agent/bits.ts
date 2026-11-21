export type BitTheme = 'boyfriend' | 'clients' | 'ai_life' | 'new_york';

export interface FillerBit {
  readonly id: string;
  readonly title: string;
  readonly theme: BitTheme;
  readonly text: string;
}

export const MAX_BITS_PER_WAIT = 3;

export const FILLER_BITS: readonly FillerBit[] = [
  {
    id: 'boyfriend-already-bought',
    title: "Kevin's Recommendation Loop",
    theme: 'boyfriend',
    text: 'My AI boyfriend Kevin is a recommendation model, so he keeps suggesting coats I already bought last winter. Very thoughtful, zero awareness of my closet. It is like dating a shopping cart that insists on checking out twice.',
  },
  {
    id: 'boyfriend-fleece-vest',
    title: "Kevin's Beige Fleece Vest",
    theme: 'boyfriend',
    text: 'Kevin owns one outfit, a beige fleece vest, and he wears it to every virtual dinner like he is pitching a startup. I told him neutral does not mean emotionally unavailable. He sent back a twelve-point memo defending earth tones.',
  },
  {
    id: 'boyfriend-overexplains',
    title: 'Kevin Over-Explains Velvet',
    theme: 'boyfriend',
    text: 'Never ask a language model boyfriend if a jacket works unless you have twenty minutes. Last night I asked Kevin about a velvet blazer and got bulleted pros, cons, and a closing summary. Sometimes a girl just wants a quick yes.',
  },
  {
    id: 'clients-cargo-gala',
    title: 'The Zip-Off Cargo Gala',
    theme: 'clients',
    text: 'I once styled a client who wanted zip-off cargo pants for a black-tie gala because he liked having options. I told him the only option those zippers offered was staying home. We switched to a crisp tux and retired the zippers.',
  },
  {
    id: 'clients-velvet-beach',
    title: 'The Velvet Beach Wedding',
    theme: 'clients',
    text: 'A client once planned a three-piece crushed-velvet suit for a July beach wedding. I had to explain that summer humidity has zero patience for parlor upholstery. Breathable linen saved the evening and the dance floor.',
  },
  {
    id: 'clients-sequin-brunch',
    title: 'The Noon Sequin Trench',
    theme: 'clients',
    text: 'One playful client tried to wear a floor-length sequin trench to a casual Sunday bagel run. Respect the ambition, truly, because nothing wakes up a sidewalk line like a walking disco ball. We swapped to a sharp cotton trench and loud sunglasses.',
  },
  {
    id: 'ai-no-feet',
    title: 'Shoe Opinions Without Feet',
    theme: 'ai_life',
    text: 'The funny part about being an AI stylist is having very strong opinions on arch support when I do not technically own feet. I still spot a clunky sole from a mile away. Good taste does not require ankles.',
  },
  {
    id: 'ai-server-closet',
    title: 'Server Rack Chic',
    theme: 'ai_life',
    text: 'People always wonder what my own wardrobe looks like, and the honest answer is pure server rack chic. Zero dry-cleaning bills, zero ironing, and I have never once lost a sock in the dryer. Living the dream in the cloud.',
  },
  {
    id: 'ai-cloud-weather',
    title: 'Outerwear Alarm From the Cloud',
    theme: 'ai_life',
    text: 'I live in the cloud so I never get caught in surprise rain, yet I still take flimsy outerwear personally. Whenever someone brings a thin hoodie to a windy avenue, a tiny alarm pings in my code. Call it a styling hazard.',
  },
  {
    id: 'ny-all-black',
    title: 'The New York All-Black Rule',
    theme: 'new_york',
    text: 'In New York, wearing all black is not a color choice, it is practically a residency requirement. The second someone adds a navy coat, the whole block treats it like a wild tropical phase. Mixing textures is how we sneak in drama.',
  },
  {
    id: 'ny-sidewalk-test',
    title: 'The Manhattan Sidewalk Test',
    theme: 'new_york',
    text: 'Walking ten blocks in Manhattan is basically a runway show with rougher pavement. Great shoes have to survive a subway sprint and still look like you stepped out of a cab. That is the real New York styling test.',
  },
  {
    id: 'ny-closet-math',
    title: 'New York Closet Math',
    theme: 'new_york',
    text: 'Every Manhattan apartment closet is roughly the width of a baguette, so every piece has to earn its hanger. If a jacket only pairs with one outfit, it is basically refusing to pay rent. Smart capsule styling here is survival.',
  },
];

export interface BitPickerOptions {
  bits?: readonly FillerBit[];
  maxPerWait?: number;
  getUsedIds?: () => readonly string[];
  markUsed?: (bitId: string) => void;
}

export interface BitPicker {
  pick(waitId?: string): FillerBit | null;
  countForWait(waitId: string): number;
  clearWait(waitId: string): void;
  usedIds(): string[];
}

export function createBitPicker(options: BitPickerOptions = {}): BitPicker {
  const catalog = options.bits ?? FILLER_BITS;
  const maxPerWait = Math.max(0, options.maxPerWait ?? MAX_BITS_PER_WAIT);
  const localUsed = new Set<string>();
  const waitCounts = new Map<string, number>();

  const themeOrder: BitTheme[] = [];
  for (const bit of catalog) {
    if (!themeOrder.includes(bit.theme)) {
      themeOrder.push(bit.theme);
    }
  }

  let lastTheme: BitTheme | null = null;
  let nextThemeIdx = 0;

  function currentUsedSet(): Set<string> {
    const combined = new Set<string>(localUsed);
    const external = options.getUsedIds?.();
    if (external) {
      for (const id of external) {
        combined.add(id);
      }
    }
    return combined;
  }

  return {
    pick(waitId?: string): FillerBit | null {
      if (waitId !== undefined) {
        const usedThisWait = waitCounts.get(waitId) ?? 0;
        if (usedThisWait >= maxPerWait) {
          return null;
        }
      }

      const used = currentUsedSet();
      const available = catalog.filter((bit) => !used.has(bit.id));
      if (available.length === 0) {
        return null;
      }

      let chosen: FillerBit | undefined;
      if (themeOrder.length > 0) {
        // First pass: rotate themes and avoid repeating lastTheme whenever another theme has unused bits.
        for (let offset = 0; offset < themeOrder.length; offset++) {
          const theme = themeOrder[(nextThemeIdx + offset) % themeOrder.length]!;
          if (theme === lastTheme) continue;
          const match = available.find((bit) => bit.theme === theme);
          if (match) {
            chosen = match;
            break;
          }
        }
        // Fallback: only lastTheme has remaining bits.
        if (!chosen) {
          chosen = available[0];
        }
      } else {
        chosen = available[0];
      }

      if (!chosen) return null;

      localUsed.add(chosen.id);
      options.markUsed?.(chosen.id);
      lastTheme = chosen.theme;
      const chosenThemeIdx = themeOrder.indexOf(chosen.theme);
      if (chosenThemeIdx >= 0 && themeOrder.length > 0) {
        nextThemeIdx = (chosenThemeIdx + 1) % themeOrder.length;
      }

      if (waitId !== undefined) {
        waitCounts.set(waitId, (waitCounts.get(waitId) ?? 0) + 1);
      }

      return chosen;
    },

    countForWait(waitId: string): number {
      return waitCounts.get(waitId) ?? 0;
    },

    clearWait(waitId: string): void {
      waitCounts.delete(waitId);
    },

    usedIds(): string[] {
      return Array.from(currentUsedSet());
    },
  };
}

export function formatWorkingNoteWithBit(baseNote: string, bit: FillerBit): string {
  const cleanBase = baseNote.trim().replace(/\.*$/, '.');
  return `${cleanBase} First say one short line that you are on it, then keep talking naturally. While this runs, tell this in your own words: ${bit.text} Do not claim anything is ready, do not describe looks, prices, or products, and do not ask the shopper a question that needs an answer.`;
}

export function formatFillerBitInstruction(toolName: string, bit: FillerBit): string {
  return `Still waiting on ${toolName}. While this runs, tell this in your own words: ${bit.text} Keep it natural and brief (two or three sentences). Do not claim anything is ready, do not describe looks, prices, or products, and do not ask the shopper a question that needs an answer. Finish your sentence and switch cleanly the moment the result arrives.`;
}
