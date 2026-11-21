// Weather parsing and outfit suitability checks for the ready-made outfit library.
import type { Outfit, Piece } from '../types.ts';

export interface WeatherSignals {
  tempF: number | null;
  rain: boolean;
  snow: boolean;
  cold: boolean;
  hot: boolean;
}

export interface WeatherFitResult {
  ok: boolean;
  reason?: string;
}

const ABOUT_TEMP_RE = /\babout\s+(-?\d+(?:\.\d+)?)\s*°\s*f\b/i;
const ANY_TEMP_RE = /(-?\d+(?:\.\d+)?)\s*°\s*f\b/i;
const RAIN_CHANCE_RE = /\b(\d+)\s*%\s*chance\s+of\s+rain\b/gi;
const RAIN_WORDS_RE = /\brain|drizzle|\bshower|storm/i;
const SNOW_WORDS_RE = /snow|sleet|flurr/i;
const COLD_WORDS_RE = /\b(cold|chilly|freezing|winter)\b/i;
const HOT_WORDS_RE = /\b(hot|humid|heat)\b/i;

function wordRegex(pattern: string): RegExp {
  return new RegExp(`(^|[^a-z])(?:${pattern})([^a-z]|$)`);
}

function pieceTitle(piece: Piece): string {
  return (piece.item?.title ?? '').toLowerCase();
}

function pieceText(piece: Piece): string {
  const title = piece.item?.title ?? '';
  const desc = piece.item?.description ?? '';
  return `${title} ${desc}`.toLowerCase();
}

const COLD_WARM_TOP_RE = wordRegex(
  'sweaters?|knit(?:ted)?|cardigans?|turtlenecks?|wool|cashmere|fleece|sherpa|long[- ]sleev(?:e|es|ed)',
);

const COLD_REJECT_RULES: Array<[string, RegExp]> = [
  ['shorts', wordRegex('shorts')],
  ['sandals', wordRegex('sandals?')],
  ['slides', wordRegex('slides?')],
  ['flip flops', wordRegex('flip[- ]flops?')],
  ['tank', wordRegex('tanks?')],
  ['cami', wordRegex('camis?(?:oles?)?')],
  ['crop', wordRegex('crop')],
  ['linen', wordRegex('linen')],
  ['mesh', wordRegex('mesh')],
  ['sleeveless', wordRegex('sleeveless')],
];

const BOTTOM_SHORT_RE = wordRegex('short');

const HOT_REJECT_RULES: Array<[string, RegExp]> = [
  ['wool', wordRegex('wool')],
  ['cashmere', wordRegex('cashmere')],
  ['velvet', wordRegex('velvet')],
  ['corduroy', wordRegex('corduroy')],
  ['fleece', wordRegex('fleece')],
  ['sherpa', wordRegex('sherpa')],
  ['puffer', wordRegex('puffers?')],
  ['parka', wordRegex('parkas?')],
  ['coat', wordRegex('coats?')],
  ['turtleneck', wordRegex('turtlenecks?')],
  ['sweater', wordRegex('sweaters?')],
  ['cardigan', wordRegex('cardigans?')],
  ['knee-high boots', wordRegex('knee[- ]high\\s+boots?')],
];

const HOT_LIGHT_LAYER_RE = wordRegex('linen|cotton|lightweight');

const RAIN_SHOE_RULES: Array<[string, RegExp]> = [
  ['suede', wordRegex('suede')],
  ['satin shoes', wordRegex('satin')],
  ['sandals', wordRegex('sandals?')],
  ['slides', wordRegex('slides?')],
  ['espadrilles', wordRegex('espadrilles?')],
];

const CANVAS_RE = wordRegex('canvas');
const SNEAKER_RE = wordRegex('sneakers?');
const SNOW_SHOE_RE = wordRegex('heels|stilettos?');

export function readWeather(line: string): WeatherSignals {
  const raw = (line ?? '').trim();
  const lower = raw.toLowerCase();

  const aboutMatch = ABOUT_TEMP_RE.exec(raw);
  const tempMatch = aboutMatch ?? ANY_TEMP_RE.exec(raw);
  const parsedTemp = tempMatch ? Number(tempMatch[1]) : null;
  const tempF = parsedTemp !== null && Number.isFinite(parsedTemp) ? parsedTemp : null;

  let highRainChance = false;
  for (const m of lower.matchAll(RAIN_CHANCE_RE)) {
    if (Number(m[1]) >= 50) {
      highRainChance = true;
      break;
    }
  }
  const withoutRainChance = lower.replace(RAIN_CHANCE_RE, ' ');
  const rain = highRainChance || RAIN_WORDS_RE.test(withoutRainChance);

  const snow = SNOW_WORDS_RE.test(lower);

  const cold =
    snow ||
    (tempF !== null ? tempF <= 55 : COLD_WORDS_RE.test(lower));

  const hot =
    tempF !== null ? tempF >= 82 : HOT_WORDS_RE.test(lower);

  return { tempF, rain, snow, cold, hot };
}

export function weatherFit(outfit: Outfit, w: WeatherSignals): WeatherFitResult {
  const pieces = outfit.pieces ?? [];

  if (w.cold || w.snow) {
    const hasLayer = pieces.some((p) => p.slot === 'layer');
    const hasWarmTop = pieces.some(
      (p) => (p.slot === 'top' || p.slot === 'dress') && COLD_WARM_TOP_RE.test(pieceTitle(p)),
    );
    if (!hasLayer && !hasWarmTop) {
      return { ok: false, reason: 'cold: needs a warm layer or top' };
    }

    for (const piece of pieces) {
      const text = pieceText(piece);
      if (piece.slot === 'bottom' && BOTTOM_SHORT_RE.test(pieceTitle(piece))) {
        return { ok: false, reason: `cold: shorts (${piece.item.title})` };
      }
      for (const [label, re] of COLD_REJECT_RULES) {
        if (re.test(text)) {
          return { ok: false, reason: `cold: ${label} (${piece.item.title})` };
        }
      }
    }
  }

  if (w.snow) {
    for (const piece of pieces) {
      if (piece.slot !== 'shoes') continue;
      if (SNOW_SHOE_RE.test(pieceText(piece))) {
        return { ok: false, reason: `snow: heels/stilettos (${piece.item.title})` };
      }
    }
  }

  if (w.hot) {
    for (const piece of pieces) {
      const text = pieceText(piece);
      for (const [label, re] of HOT_REJECT_RULES) {
        if (re.test(text)) {
          return { ok: false, reason: `hot: ${label} (${piece.item.title})` };
        }
      }
      if (piece.slot === 'layer' && !HOT_LIGHT_LAYER_RE.test(text)) {
        return { ok: false, reason: `hot: heavy layer (${piece.item.title})` };
      }
    }
  }

  if (w.rain) {
    for (const piece of pieces) {
      if (piece.slot !== 'shoes') continue;
      const text = pieceText(piece);
      if (CANVAS_RE.test(text) && SNEAKER_RE.test(text)) {
        return { ok: false, reason: `rain: canvas sneakers (${piece.item.title})` };
      }
      for (const [label, re] of RAIN_SHOE_RULES) {
        if (re.test(text)) {
          return { ok: false, reason: `rain: ${label} (${piece.item.title})` };
        }
      }
    }
  }

  return { ok: true };
}
