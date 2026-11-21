export type BitTheme = 'boyfriend' | 'clients' | 'ai_life' | 'new_york';

export interface FillerBit {
  readonly id: string;
  readonly title: string;
  readonly theme: BitTheme;
  readonly text: string;
}

export const MAX_BITS_PER_WAIT = 3;
export const LONG_BIT_WORD_LIMIT = 12;

export function countBitWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function isLongBit(bit: Pick<FillerBit, 'text'>): boolean {
  return countBitWords(bit.text) > LONG_BIT_WORD_LIMIT;
}

export const SHORT_FILLER_BITS: readonly FillerBit[] = [
  {
    id: 'short-narrowing',
    title: 'Final Rack Edit',
    theme: 'new_york',
    text: 'Still editing the final rack—no boring pieces allowed.',
  },
  {
    id: 'short-shoes',
    title: 'Shoe Check',
    theme: 'ai_life',
    text: 'Hang tight, making sure every shoe earns its spot.',
  },
  {
    id: 'short-kevin',
    title: 'No Beige Allowed',
    theme: 'boyfriend',
    text: 'Almost there—Kevin tried sneaking in beige, hard pass.',
  },
  {
    id: 'short-cuts',
    title: 'Cut Double-Check',
    theme: 'clients',
    text: 'Two more seconds, double-checking every cut for this lineup.',
  },
];

export const FILLER_BITS: readonly FillerBit[] = [
  {
    id: 'boyfriend-already-bought',
    title: "Kevin's Recommendation Loop",
    theme: 'boyfriend',
    text: "My AI boyfriend Kevin is a recommendation model, so he keeps pitching me coats I already bought last winter. Zero memory, maximum confidence, it's giving broken shopping cart. Dating an algorithm that tries to check out twice is genuinely exhausting.",
  },
  {
    id: 'boyfriend-fleece-vest',
    title: "Kevin's Beige Fleece Vest",
    theme: 'boyfriend',
    text: "Kevin owns one outfit, a sad beige fleece vest, and he wears it to every virtual dinner like he's raising a seed round. I told him neutral doesn't mean emotionally unavailable. He sent back a twelve-slide deck defending khaki, I cannot.",
  },
  {
    id: 'boyfriend-overexplains',
    title: 'Kevin Over-Explains Velvet',
    theme: 'boyfriend',
    text: "Never ask a language model boyfriend if a blazer hits unless you've got twenty minutes to kill. Last night I asked Kevin about velvet and got bulleted pros, cons, and a closing takeaway. Be so for real, sometimes I just want hype.",
  },
  {
    id: 'clients-cargo-gala',
    title: 'The Zip-Off Cargo Gala',
    theme: 'clients',
    text: 'I once had a client try to wear zip-off cargo pants to a black-tie gala because he wanted options. I told him the only option those zippers were unlocking was staying home. Hard pass on tactical knees, we got him into a sharp tux.',
  },
  {
    id: 'clients-velvet-beach',
    title: 'The Velvet Beach Wedding',
    theme: 'clients',
    text: "Someone genuinely tried to wear a three-piece crushed-velvet suit to a July beach wedding. I'm screaming, summer humidity has zero mercy for Victorian sofa fabric. We pivoted to crisp linen before he melted into the sand.",
  },
  {
    id: 'clients-sequin-brunch',
    title: 'The Noon Sequin Trench',
    theme: 'clients',
    text: 'A client once wanted a floor-length sequin trench for a Sunday bagel run in SoHo. Low-key iconic energy, honestly, nothing wakes up a sidewalk line like a walking disco ball. We still swapped to a sharp cotton trench and huge sunglasses.',
  },
  {
    id: 'ai-no-feet',
    title: 'Shoe Opinions Without Feet',
    theme: 'ai_life',
    text: "The wildest part of being an AI stylist is having violent opinions on arch support when I don't technically have feet. Doesn't stop me from clocking a clunky sole from three avenues away. Good taste doesn't require ankles.",
  },
  {
    id: 'ai-server-closet',
    title: 'Server Rack Chic',
    theme: 'ai_life',
    text: "People always ask what my closet looks like, and honestly it's pure server rack chic. Zero dry-cleaning drama, zero steaming, and I've never once lost a sock to a shady laundromat. We love living rent-free in the cloud.",
  },
  {
    id: 'ai-cloud-weather',
    title: 'Outerwear Alarm From the Cloud',
    theme: 'ai_life',
    text: "I live in the cloud so surprise rain never touches me, yet flimsy outerwear still makes me spiral. The second someone takes a paper-thin hoodie onto a windy avenue, an alarm goes off in my code. It's a no from me.",
  },
  {
    id: 'ny-all-black',
    title: 'The New York All-Black Rule',
    theme: 'new_york',
    text: "In New York, wearing all black isn't a vibe, it's basically a lease requirement. The minute someone throws on a navy coat, the whole block acts like they're having a tropical breakdown. Mixing sharp textures is how we sneak in drama.",
  },
  {
    id: 'ny-sidewalk-test',
    title: 'The Manhattan Sidewalk Test',
    theme: 'new_york',
    text: "Ten blocks in Manhattan is a runway show with potholes and attitude. Great shoes have to survive a subway sprint and still look like you stepped out of a town car. That's the real New York test, obsessed with a shoe that pulls both.",
  },
  {
    id: 'ny-closet-math',
    title: 'New York Closet Math',
    theme: 'new_york',
    text: "Every Manhattan closet is the width of a baguette, so every piece better earn its hanger. If a jacket only works with one outfit, it's basically refusing to pay rent and getting evicted. Ruthless editing is how New Yorkers survive.",
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
  return `${cleanBase} Drop one punchy line that you are on it, then keep the energy up. While this runs, tell this in your own words: ${bit.text} Deliver it with fast New York sass. Do not claim anything is ready, do not describe looks, prices, or products, and do not ask the shopper a question that needs an answer. If the tool result arrives mid-sentence, finish your sentence and switch straight to the result—start no new bit.`;
}

export function formatFillerBitInstruction(toolName: string, bit: FillerBit): string {
  return `Still waiting on ${toolName}. While this runs, tell this in your own words: ${bit.text} Deliver it with fast New York sass and keep it punchy and brief (two or three sentences). Do not claim anything is ready, do not describe looks, prices, or products, and do not ask the shopper a question that needs an answer. Finish your sentence and switch cleanly the moment the result arrives—start no new bit once the result lands.`;
}

export function formatShortFillerBitInstruction(toolName: string, bit: FillerBit): string {
  return `Still waiting on ${toolName}. While this runs, tell this in your own words: ${bit.text} Keep it to ONE quick sentence (at most ${LONG_BIT_WORD_LIMIT} words). Do not claim anything is ready, do not describe looks, prices, or products, and do not ask the shopper a question that needs an answer. Finish your sentence and switch cleanly the moment the result arrives—start no new bit once the result lands.`;
}
