/**
 * Keyless weather forecast lookup via Open-Meteo for forecast-aware styling.
 *
 * The agent can call `warmWeather()` at job start to prime DNS/TLS and cache the
 * default city's forecast in the background without blocking or throwing.
 */

export interface Weather {
  ok: boolean;
  source: 'forecast' | 'season' | 'none';
  place: string;
  date: string; // YYYY-MM-DD
  temp_f: number | null; // around 7 PM local, else the day's mean
  high_f: number | null;
  low_f: number | null;
  conditions: string; // e.g. "clear", "light rain", "snow", "windy and overcast"
  wind_mph: number | null;
  rain_chance: number | null; // 0-100
  line: string;
  ms: number;
  assumed_place?: boolean;
}

export type WhereInput = string | { lat: number; lon: number };

export interface ForecastOptions {
  now?: Date;
  fetch?: typeof fetch;
}

const DEFAULT_PLACE = 'New York';
const DEFAULT_COORDS: GeoInfo = { name: 'New York', lat: 40.7128, lon: -74.006 };
const COLD_TIME_BUDGET_MS = 3500;
const WARM_TIME_BUDGET_MS = 1500;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_FORECAST_DAYS = 10;
const WINDY_THRESHOLD_MPH = 15;
const NY_TIMEZONE = 'America/New_York';

const GEOCODE_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

interface CacheEntry {
  storedAt: number;
  weather: Weather;
}

interface GeoInfo {
  name: string;
  lat: number;
  lon: number;
}

const weatherCache = new Map<string, CacheEntry>();
const geocodeCache = new Map<string, GeoInfo>();
let moduleWarm = false;

export function clearWeatherCache(): void {
  weatherCache.clear();
  geocodeCache.clear();
  moduleWarm = false;
}

// ---------------------------------------------------------------------------
// Built-in coordinates for well-known places (skips geocoding)
// ---------------------------------------------------------------------------

const BUILTIN_PLACES: Record<string, GeoInfo> = {
  'new york': { name: 'New York', lat: 40.7128, lon: -74.006 },
  'new york city': { name: 'New York', lat: 40.7128, lon: -74.006 },
  nyc: { name: 'New York', lat: 40.7128, lon: -74.006 },
  ny: { name: 'New York', lat: 40.7128, lon: -74.006 },
  manhattan: { name: 'Manhattan', lat: 40.7831, lon: -73.9712 },
  brooklyn: { name: 'Brooklyn', lat: 40.6782, lon: -73.9442 },
  queens: { name: 'Queens', lat: 40.7282, lon: -73.7949 },
  'los angeles': { name: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  la: { name: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  chicago: { name: 'Chicago', lat: 41.8781, lon: -87.6298 },
  miami: { name: 'Miami', lat: 25.7617, lon: -80.1918 },
  'san francisco': { name: 'San Francisco', lat: 37.7749, lon: -122.4194 },
  sf: { name: 'San Francisco', lat: 37.7749, lon: -122.4194 },
  boston: { name: 'Boston', lat: 42.3601, lon: -71.0589 },
  'washington dc': { name: 'Washington DC', lat: 38.9072, lon: -77.0369 },
  'washington d c': { name: 'Washington DC', lat: 38.9072, lon: -77.0369 },
  washington: { name: 'Washington DC', lat: 38.9072, lon: -77.0369 },
  dc: { name: 'Washington DC', lat: 38.9072, lon: -77.0369 },
  seattle: { name: 'Seattle', lat: 47.6062, lon: -122.3321 },
  austin: { name: 'Austin', lat: 30.2672, lon: -97.7431 },
  'las vegas': { name: 'Las Vegas', lat: 36.1699, lon: -115.1398 },
  vegas: { name: 'Las Vegas', lat: 36.1699, lon: -115.1398 },
  london: { name: 'London', lat: 51.5074, lon: -0.1278 },
  paris: { name: 'Paris', lat: 48.8566, lon: 2.3522 },
  tokyo: { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  lisbon: { name: 'Lisbon', lat: 38.7223, lon: -9.1393 },
  'mexico city': { name: 'Mexico City', lat: 19.4326, lon: -99.1332 },
  toronto: { name: 'Toronto', lat: 43.6532, lon: -79.3832 },
};

const VENUE_WORDS = new Set([
  'rooftop',
  'rooftops',
  'bar',
  'bars',
  'party',
  'parties',
  'wedding',
  'weddings',
  'office',
  'offices',
  'downtown',
  'uptown',
  'restaurant',
  'restaurants',
  'club',
  'clubs',
  'beach',
  'beaches',
  'park',
  'parks',
]);

function normalizePlaceKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupBuiltinPlace(candidate: string): GeoInfo | null {
  const key = normalizePlaceKey(candidate);
  if (!key) return null;
  return BUILTIN_PLACES[key] ?? null;
}

// ---------------------------------------------------------------------------
// Date resolution in America/New_York
// ---------------------------------------------------------------------------

const nyPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const WEEKDAY_LOOKUP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

interface YMD {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

function dateToNyYmd(date: Date): YMD {
  const parts = nyPartsFormatter.formatToParts(date);
  let year = 1970;
  let month = 1;
  let day = 1;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return { year, month, day };
}

function formatYmd(ymd: YMD): string {
  const y = String(ymd.year).padStart(4, '0');
  const m = String(ymd.month).padStart(2, '0');
  const d = String(ymd.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYmd(str: string): YMD | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function addDays(ymd: YMD, delta: number): YMD {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + delta));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function dayOfWeek(ymd: YMD): number {
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay();
}

function diffDays(from: YMD, to: YMD): number {
  const msA = Date.UTC(from.year, from.month - 1, from.day);
  const msB = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((msB - msA) / 86_400_000);
}

const DATE_PHRASE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/i,
  /\bin\s+\d+\s+days?\b/i,
  /\b(?:this\s+)?weekend\b/i,
  /\btomorrow(?:\s+(?:night|evening|afternoon|morning))?\b/i,
  /\b(?:tonight|today|this\s+(?:evening|afternoon|morning))\b/i,
  /\b(?:(?:this|next)\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:night|evening|afternoon|morning))?\b/i,
  /\b(?:this|next)\s+(?:sun|mon|tues?|weds?|thurs?|thur|fri|sat)(?:\s+(?:night|evening|afternoon|morning))?\b/i,
  /\b(?:sun|mon|tues?|weds?|thurs?|thur|fri|sat)\s+(?:night|evening|afternoon|morning)\b/i,
];

function extractDateFromPlace(raw: string): { datePhrase: string | null; stripped: string } {
  for (const pattern of DATE_PHRASE_PATTERNS) {
    const match = pattern.exec(raw);
    if (match && match[0]) {
      const before = raw.slice(0, match.index);
      const after = raw.slice(match.index + match[0].length);
      const stripped = `${before} ${after}`.replace(/\s+/g, ' ').trim();
      return { datePhrase: match[0].trim(), stripped };
    }
  }
  return { datePhrase: null, stripped: raw };
}

const PLACE_CUT_PATTERNS: RegExp[] = [
  /\s\/\s/,
  /\//,
  /,/,
  /\s[-–—]\s/,
  /\son\s/i,
  /\sat\s/i,
  /\sthis\s/i,
  /\snext\s/i,
  /\stonight\b/i,
  /\stomorrow\b/i,
];

function buildPlaceCandidates(raw: string): string[] {
  let text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return [];

  // Cut at the earliest separator or temporal/prepositional marker.
  let earliestIdx = text.length;
  for (const pattern of PLACE_CUT_PATTERNS) {
    const m = pattern.exec(text);
    if (m && m.index < earliestIdx) {
      earliestIdx = m.index;
    }
  }
  text = text.slice(0, earliestIdx).trim();

  // Also strip any trailing/embedded date phrase if still present.
  text = extractDateFromPlace(text).stripped;

  // Strip stray punctuation at edges and collapse whitespace.
  text = text.replace(/^[,/\-–—\s]+|[,/\-–—\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  // Drop venue words (rooftop, bar, party, wedding, office, downtown, uptown, restaurant, club, beach, park).
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9.'-]+$/g, ''))
    .filter((w) => w.length > 0 && !VENUE_WORDS.has(w.toLowerCase()));

  if (words.length === 0) return [];

  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: string): void => {
    const trimmed = candidate.trim();
    const key = normalizePlaceKey(trimmed);
    if (trimmed && key && !seen.has(key)) {
      seen.add(key);
      candidates.push(trimmed);
    }
  };

  pushCandidate(words.join(' '));
  if (words.length >= 2) {
    pushCandidate(words.slice(0, 2).join(' '));
  }
  if (words.length >= 1) {
    pushCandidate(words[0]!);
  }

  return candidates;
}

export function resolveDate(when?: string | Date, now: Date = new Date()): string {
  const refDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const today = dateToNyYmd(refDate);

  if (when === undefined || when === null) {
    return formatYmd(today);
  }

  if (when instanceof Date) {
    if (Number.isNaN(when.getTime())) {
      return formatYmd(today);
    }
    return formatYmd(dateToNyYmd(when));
  }

  if (typeof when !== 'string') {
    return formatYmd(today);
  }

  const trimmed = when.trim();
  if (!trimmed) {
    return formatYmd(today);
  }

  const exact = parseYmd(trimmed);
  if (exact) {
    return formatYmd(exact);
  }

  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');

  if (
    normalized === 'today' ||
    normalized === 'tonight' ||
    normalized === 'this evening' ||
    normalized === 'this afternoon' ||
    normalized === 'this morning'
  ) {
    return formatYmd(today);
  }

  if (
    normalized === 'tomorrow' ||
    normalized === 'tomorrow night' ||
    normalized === 'tomorrow evening' ||
    normalized === 'tomorrow afternoon' ||
    normalized === 'tomorrow morning'
  ) {
    return formatYmd(addDays(today, 1));
  }

  if (normalized === 'this weekend' || normalized === 'weekend') {
    const todayDow = dayOfWeek(today);
    const delta = (6 - todayDow + 7) % 7;
    return formatYmd(addDays(today, delta));
  }

  const inDaysMatch = /^in\s+(\d+)\s+days?$/.exec(normalized);
  if (inDaysMatch) {
    const n = Number(inDaysMatch[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 3650) {
      return formatYmd(addDays(today, n));
    }
  }

  // Strip optional trailing time-of-day words like "night" / "evening"
  const withoutTimeOfDay = normalized.replace(/\s+(night|evening|afternoon|morning)$/, '');

  // "next <weekday>" -> that weekday in next week (Mon-Sun week)
  const nextMatch = /^next\s+([a-z]+)$/.exec(withoutTimeOfDay);
  if (nextMatch) {
    const targetDow = WEEKDAY_LOOKUP[nextMatch[1]!];
    if (targetDow !== undefined) {
      const todayDow = dayOfWeek(today);
      const daysUntilNextMonday = 7 - ((todayDow + 6) % 7);
      const targetOffsetFromMonday = (targetDow + 6) % 7;
      return formatYmd(addDays(today, daysUntilNextMonday + targetOffsetFromMonday));
    }
  }

  // "this <weekday>" or bare "<weekday>" -> next occurrence, today counts
  const bareMatch = /^(?:this\s+)?([a-z]+)$/.exec(withoutTimeOfDay);
  if (bareMatch) {
    const targetDow = WEEKDAY_LOOKUP[bareMatch[1]!];
    if (targetDow !== undefined) {
      const todayDow = dayOfWeek(today);
      const delta = (targetDow - todayDow + 7) % 7;
      return formatYmd(addDays(today, delta));
    }
  }

  return formatYmd(today);
}

// ---------------------------------------------------------------------------
// WMO Weather Codes
// ---------------------------------------------------------------------------

function wmoToCondition(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return '';
  switch (code) {
    case 0:
      return 'clear';
    case 1:
      return 'mostly clear';
    case 2:
      return 'partly cloudy';
    case 3:
      return 'overcast';
    case 45:
    case 48:
      return 'foggy';
    case 51:
    case 53:
      return 'light drizzle';
    case 55:
      return 'drizzle';
    case 56:
    case 57:
      return 'freezing drizzle';
    case 61:
      return 'light rain';
    case 63:
      return 'rain';
    case 65:
      return 'heavy rain';
    case 66:
    case 67:
      return 'freezing rain';
    case 71:
      return 'light snow';
    case 73:
      return 'snow';
    case 75:
      return 'heavy snow';
    case 77:
      return 'snow flurries';
    case 80:
      return 'light rain';
    case 81:
      return 'rain showers';
    case 82:
      return 'heavy rain';
    case 85:
      return 'light snow';
    case 86:
      return 'heavy snow';
    case 95:
      return 'thunderstorms';
    case 96:
    case 99:
      return 'severe thunderstorms';
    default:
      return '';
  }
}

function isSnowCode(code: number | null): boolean {
  return code !== null && ((code >= 71 && code <= 77) || code === 85 || code === 86);
}

// ---------------------------------------------------------------------------
// Seasonal fallback (no network calls)
// ---------------------------------------------------------------------------

interface CityClimateHint {
  lat: number;
  humid?: boolean;
}

const KNOWN_CITIES: Record<string, CityClimateHint> = {
  'new york': { lat: 40.71, humid: true },
  nyc: { lat: 40.71, humid: true },
  manhattan: { lat: 40.78, humid: true },
  brooklyn: { lat: 40.68, humid: true },
  queens: { lat: 40.73, humid: true },
  miami: { lat: 25.77, humid: true },
  'los angeles': { lat: 34.05 },
  la: { lat: 34.05 },
  'san francisco': { lat: 37.77 },
  sf: { lat: 37.77 },
  chicago: { lat: 41.88 },
  boston: { lat: 42.36 },
  seattle: { lat: 47.61 },
  austin: { lat: 30.27, humid: true },
  houston: { lat: 29.76, humid: true },
  dallas: { lat: 32.78 },
  atlanta: { lat: 33.75, humid: true },
  'new orleans': { lat: 29.95, humid: true },
  orlando: { lat: 28.54, humid: true },
  tampa: { lat: 27.95, humid: true },
  washington: { lat: 38.91, humid: true },
  'washington dc': { lat: 38.91, humid: true },
  philadelphia: { lat: 39.95 },
  denver: { lat: 39.74 },
  phoenix: { lat: 33.45 },
  'las vegas': { lat: 36.17 },
  'san diego': { lat: 32.72 },
  honolulu: { lat: 21.31, humid: true },
  anchorage: { lat: 61.22 },
  toronto: { lat: 43.65 },
  montreal: { lat: 45.5 },
  vancouver: { lat: 49.28 },
  'mexico city': { lat: 19.43 },
  cancun: { lat: 21.16, humid: true },
  london: { lat: 51.51 },
  paris: { lat: 48.86 },
  rome: { lat: 41.9 },
  milan: { lat: 45.46 },
  madrid: { lat: 40.42 },
  barcelona: { lat: 41.39 },
  berlin: { lat: 52.52 },
  amsterdam: { lat: 52.37 },
  zurich: { lat: 47.37 },
  dublin: { lat: 53.35 },
  lisbon: { lat: 38.72 },
  athens: { lat: 37.98 },
  stockholm: { lat: 59.33 },
  oslo: { lat: 59.91 },
  reykjavik: { lat: 64.15 },
  moscow: { lat: 55.76 },
  istanbul: { lat: 41.01 },
  tokyo: { lat: 35.69 },
  kyoto: { lat: 35.01 },
  osaka: { lat: 34.69 },
  seoul: { lat: 37.57 },
  beijing: { lat: 39.9 },
  shanghai: { lat: 31.23, humid: true },
  'hong kong': { lat: 22.32, humid: true },
  taipei: { lat: 25.03, humid: true },
  singapore: { lat: 1.35, humid: true },
  bangkok: { lat: 13.76, humid: true },
  manila: { lat: 14.6, humid: true },
  jakarta: { lat: -6.21, humid: true },
  bali: { lat: -8.34, humid: true },
  mumbai: { lat: 19.08, humid: true },
  delhi: { lat: 28.61 },
  dubai: { lat: 25.2 },
  cairo: { lat: 30.04 },
  nairobi: { lat: -1.29 },
  lagos: { lat: 6.52, humid: true },
  'cape town': { lat: -33.92 },
  johannesburg: { lat: -26.2 },
  sydney: { lat: -33.87 },
  melbourne: { lat: -37.81 },
  brisbane: { lat: -27.47, humid: true },
  auckland: { lat: -36.85 },
  'buenos aires': { lat: -34.6 },
  'sao paulo': { lat: -23.55, humid: true },
  'rio de janeiro': { lat: -22.91, humid: true },
  santiago: { lat: -33.45 },
  lima: { lat: -12.05 },
  bogota: { lat: 4.71 },
};

function partOfMonth(day: number): string {
  if (day <= 10) return 'early';
  if (day <= 20) return 'mid-';
  return 'late';
}

function formatMonthPhrase(ymd: YMD): string {
  const monthName = MONTH_NAMES[ymd.month - 1] ?? 'this month';
  const part = partOfMonth(ymd.day);
  return part === 'mid-' ? `mid-${monthName}` : `${part} ${monthName}`;
}

function describeSeason(month: number, lat: number, humid: boolean): string {
  const absLat = Math.abs(lat);

  // Tropics: always warm
  if (absLat < 23.5) {
    return humid ? 'warm and humid' : 'warm';
  }

  // Flip seasons for Southern Hemisphere
  const effMonth = lat < 0 ? ((month - 1 + 6) % 12) + 1 : month;

  let base: 'hot' | 'warm' | 'mild' | 'cool' | 'cold';

  if (absLat < 32) {
    // Subtropical (e.g. Miami, Houston, Dubai, Brisbane)
    if (effMonth >= 6 && effMonth <= 9) base = 'hot';
    else if (effMonth === 4 || effMonth === 5 || effMonth === 10) base = 'warm';
    else base = 'mild';
  } else if (absLat < 48) {
    // Temperate (e.g. New York, Tokyo, Sydney, Rome, Chicago)
    if (effMonth === 7 || effMonth === 8) base = absLat < 42 ? 'hot' : 'warm';
    else if (effMonth === 6 || effMonth === 9) base = 'warm';
    else if (effMonth === 5 || effMonth === 10) base = 'mild';
    else if (effMonth === 3 || effMonth === 4 || effMonth === 11) base = 'cool';
    else base = absLat >= 38 ? 'cold' : 'cool';
  } else {
    // High latitude (e.g. London, Paris, Stockholm, Moscow, Anchorage)
    if (effMonth >= 6 && effMonth <= 8) base = absLat < 58 ? 'warm' : 'mild';
    else if (effMonth === 5 || effMonth === 9) base = 'mild';
    else if (effMonth === 4 || effMonth === 10) base = 'cool';
    else base = 'cold';
  }

  if (humid && (base === 'hot' || base === 'warm')) {
    return `${base} and humid`;
  }
  return base;
}

function buildSeasonWeather(
  place: string,
  isCoords: boolean,
  lat: number,
  humid: boolean,
  target: YMD,
  deltaDays: number,
  startPerf: number,
  assumedPlace = false,
): Weather {
  const dateStr = formatYmd(target);
  const conditions = describeSeason(target.month, lat, humid);
  const monthPhrase = formatMonthPhrase(target);
  const lead =
    deltaDays < 0
      ? 'That date is in the past'
      : "That's too far out for a forecast";
  const locationPhrase = isCoords ? 'at that latitude' : `in ${place}`;
  const line = `${lead}; ${monthPhrase} ${locationPhrase} is usually ${conditions}.`;

  return {
    ok: true,
    source: 'season',
    place,
    date: dateStr,
    temp_f: null,
    high_f: null,
    low_f: null,
    conditions,
    wind_mph: null,
    rain_chance: null,
    line,
    ms: elapsedMs(startPerf),
    ...(assumedPlace ? { assumed_place: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Line formatting for forecasts
// ---------------------------------------------------------------------------

function formatDayLabel(target: YMD, deltaDays: number): string {
  if (deltaDays === 0) return 'Today';
  if (deltaDays === 1) return 'Tomorrow';
  return WEEKDAY_NAMES[dayOfWeek(target)] ?? formatYmd(target);
}

function buildForecastLine(params: {
  place: string;
  isCoords: boolean;
  target: YMD;
  deltaDays: number;
  temp_f: number | null;
  hasEveningTemp: boolean;
  high_f: number | null;
  low_f: number | null;
  baseCondition: string;
  wmoCode: number | null;
  wind_mph: number | null;
  rain_chance: number | null;
}): string {
  const dayLabel = formatDayLabel(params.target, params.deltaDays);
  const header = params.isCoords ? `${dayLabel}:` : `${dayLabel} in ${params.place}:`;

  const clauses: string[] = [];
  if (params.temp_f !== null) {
    clauses.push(
      params.hasEveningTemp
        ? `about ${params.temp_f}°F in the evening`
        : `around ${params.temp_f}°F`,
    );
  }

  const isWindy = params.wind_mph !== null && params.wind_mph >= WINDY_THRESHOLD_MPH;
  if (params.baseCondition) {
    clauses.push(params.baseCondition);
  }
  if (isWindy) {
    clauses.push(`windy (${params.wind_mph} mph)`);
  }

  if (params.rain_chance !== null && params.rain_chance > 0) {
    const precipWord = isSnowCode(params.wmoCode) ? 'snow' : 'rain';
    clauses.push(`${params.rain_chance}% chance of ${precipWord}`);
  }

  let sentence = clauses.length > 0 ? `${header} ${clauses.join(', ')}` : header;

  if (params.high_f !== null && params.low_f !== null) {
    sentence += `; high ${params.high_f}, low ${params.low_f}.`;
  } else if (params.high_f !== null) {
    sentence += `; high ${params.high_f}.`;
  } else if (params.low_f !== null) {
    sentence += `; low ${params.low_f}.`;
  } else {
    sentence += '.';
  }

  return sentence;
}

// ---------------------------------------------------------------------------
// Helpers & API fetching
// ---------------------------------------------------------------------------

function elapsedMs(startPerf: number): number {
  return Math.max(0, Math.round(performance.now() - startPerf));
}

function noneWeather(place: string, date: string, startPerf: number): Weather {
  return {
    ok: false,
    source: 'none',
    place,
    date,
    temp_f: null,
    high_f: null,
    low_f: null,
    conditions: '',
    wind_mph: null,
    rain_chance: null,
    line: '',
    ms: elapsedMs(startPerf),
  };
}

function finiteNumber(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function normalizeCityName(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : DEFAULT_PLACE;
}

interface ParsedWhere {
  valid: boolean;
  isCoords: boolean;
  displayPlace: string;
  candidates: string[];
  builtinHit: GeoInfo | null;
  assumedDefault: boolean;
  lat?: number;
  lon?: number;
}

function parseWhere(where: WhereInput): ParsedWhere {
  if (where === undefined || where === null) {
    return {
      valid: true,
      isCoords: false,
      displayPlace: DEFAULT_PLACE,
      candidates: [],
      builtinHit: DEFAULT_COORDS,
      assumedDefault: true,
    };
  }

  if (typeof where === 'string') {
    const candidates = buildPlaceCandidates(where);
    if (candidates.length === 0) {
      return {
        valid: true,
        isCoords: false,
        displayPlace: DEFAULT_PLACE,
        candidates: [],
        builtinHit: DEFAULT_COORDS,
        assumedDefault: true,
      };
    }

    // Check candidates against built-in places table before geocoding.
    for (const candidate of candidates) {
      const hit = lookupBuiltinPlace(candidate);
      if (hit) {
        return {
          valid: true,
          isCoords: false,
          displayPlace: hit.name,
          candidates,
          builtinHit: hit,
          assumedDefault: false,
        };
      }
    }

    return {
      valid: true,
      isCoords: false,
      displayPlace: candidates[0]!,
      candidates,
      builtinHit: null,
      assumedDefault: false,
    };
  }

  if (typeof where === 'object') {
    const lat = finiteNumber((where as { lat?: unknown }).lat);
    const lon = finiteNumber((where as { lon?: unknown }).lon);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return {
        valid: false,
        isCoords: true,
        displayPlace: '',
        candidates: [],
        builtinHit: null,
        assumedDefault: false,
      };
    }
    const displayPlace = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    return {
      valid: true,
      isCoords: true,
      displayPlace,
      candidates: [],
      builtinHit: null,
      assumedDefault: false,
      lat,
      lon,
    };
  }

  return {
    valid: false,
    isCoords: false,
    displayPlace: '',
    candidates: [],
    builtinHit: null,
    assumedDefault: false,
  };
}

function lookupCityClimate(city: string): CityClimateHint {
  const key = normalizePlaceKey(city);
  const known = KNOWN_CITIES[key];
  if (known) return known;

  const builtin = BUILTIN_PLACES[key];
  if (builtin) return { lat: builtin.lat };

  const cachedGeo = geocodeCache.get(key);
  if (cachedGeo) return { lat: cachedGeo.lat };

  // Fallback to northern temperate mid-latitude
  return { lat: 40.71 };
}

async function fetchJsonWithSignal(
  fetchFn: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetchFn(url, { signal });
  if (!res || !res.ok) {
    throw new Error(`HTTP ${res?.status ?? 'error'}`);
  }
  const data = await res.json();
  moduleWarm = true;
  return data;
}

interface GeocodeApiResponse {
  results?: Array<{
    name?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  }>;
}

interface ForecastApiResponse {
  daily?: {
    time?: unknown[];
    temperature_2m_max?: unknown[];
    temperature_2m_min?: unknown[];
    precipitation_probability_max?: unknown[];
    weather_code?: unknown[];
    wind_speed_10m_max?: unknown[];
  };
  hourly?: {
    time?: unknown[];
    temperature_2m?: unknown[];
  };
}

function cacheKeyForGeo(placeName: string, isCoords: boolean, lat: number, lon: number, dateStr: string): string {
  if (isCoords) {
    return `coords:${lat.toFixed(4)},${lon.toFixed(4)}|${dateStr}`;
  }
  return `city:${normalizePlaceKey(placeName)}|${dateStr}`;
}

function getCachedWeather(cacheKey: string, nowMs: number, startPerf: number, assumedPlace: boolean): Weather | null {
  const cached = weatherCache.get(cacheKey);
  if (!cached) return null;
  const age = nowMs - cached.storedAt;
  if (age >= 0 && age < CACHE_TTL_MS) {
    const base: Weather = { ...cached.weather, ms: elapsedMs(startPerf) };
    if (assumedPlace) {
      base.assumed_place = true;
    } else {
      delete base.assumed_place;
    }
    return base;
  }
  weatherCache.delete(cacheKey);
  return null;
}

function storeCachedWeather(cacheKey: string, nowMs: number, weather: Weather): void {
  const canonical: Weather = { ...weather };
  delete canonical.assumed_place;
  weatherCache.set(cacheKey, { storedAt: nowMs, weather: canonical });
}

export function warmWeather(
  place: WhereInput = DEFAULT_PLACE,
  opts?: ForecastOptions,
): Promise<Weather> {
  try {
    const p = forecast(place, 'today', opts);
    p.catch(() => {});
    return p;
  } catch {
    return Promise.resolve(noneWeather(DEFAULT_PLACE, resolveDate('today', opts?.now), performance.now()));
  }
}

export async function forecast(
  where: WhereInput,
  when?: string | Date,
  opts?: ForecastOptions,
): Promise<Weather> {
  const startPerf = performance.now();

  try {
    const now = opts?.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();
    const nowMs = now.getTime();
    const todayYmd = dateToNyYmd(now);

    const hasExplicitWhen =
      when !== undefined &&
      when !== null &&
      !(typeof when === 'string' && when.trim().length === 0);

    let effectiveWhen: string | Date | undefined = when;
    if (!hasExplicitWhen && typeof where === 'string') {
      const extracted = extractDateFromPlace(where);
      if (extracted.datePhrase) {
        effectiveWhen = extracted.datePhrase;
      }
    }

    const dateStr = resolveDate(effectiveWhen, now);
    const targetYmd = parseYmd(dateStr) ?? todayYmd;
    const deltaDays = diffDays(todayYmd, targetYmd);

    const parsed = parseWhere(where);
    if (!parsed.valid) {
      return noneWeather(parsed.displayPlace, dateStr, startPerf);
    }

    // Beyond 10 days out or in the past: seasonal estimate without any fetch call
    if (deltaDays > MAX_FORECAST_DAYS || deltaDays < 0) {
      const seasonPlace = parsed.builtinHit?.name ?? parsed.displayPlace;
      const climate = parsed.isCoords
        ? { lat: parsed.lat!, humid: false }
        : lookupCityClimate(seasonPlace);
      const seasonKey = parsed.isCoords
        ? cacheKeyForGeo(seasonPlace, true, parsed.lat!, parsed.lon!, dateStr)
        : `city:${normalizePlaceKey(seasonPlace)}|${dateStr}`;

      const hit = getCachedWeather(seasonKey, nowMs, startPerf, parsed.assumedDefault);
      if (hit) return hit;

      const seasonResult = buildSeasonWeather(
        seasonPlace,
        parsed.isCoords,
        climate.lat,
        Boolean(climate.humid),
        targetYmd,
        deltaDays,
        startPerf,
        parsed.assumedDefault,
      );
      storeCachedWeather(seasonKey, nowMs, seasonResult);
      return seasonResult;
    }

    // Fast path: cache check when coordinates/place are already known without network
    if (parsed.isCoords) {
      const coordKey = cacheKeyForGeo(parsed.displayPlace, true, parsed.lat!, parsed.lon!, dateStr);
      const hit = getCachedWeather(coordKey, nowMs, startPerf, false);
      if (hit) return hit;
    } else if (parsed.builtinHit) {
      const builtinKey = cacheKeyForGeo(
        parsed.builtinHit.name,
        false,
        parsed.builtinHit.lat,
        parsed.builtinHit.lon,
        dateStr,
      );
      const hit = getCachedWeather(builtinKey, nowMs, startPerf, parsed.assumedDefault);
      if (hit) return hit;
    } else {
      for (const candidate of parsed.candidates) {
        const cachedGeo = geocodeCache.get(normalizePlaceKey(candidate));
        if (cachedGeo) {
          const geoKey = cacheKeyForGeo(cachedGeo.name, false, cachedGeo.lat, cachedGeo.lon, dateStr);
          const hit = getCachedWeather(geoKey, nowMs, startPerf, false);
          if (hit) return hit;
          break;
        }
      }
    }

    const fetchFn = opts?.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      return noneWeather(parsed.displayPlace, dateStr, startPerf);
    }

    const budgetMs = moduleWarm ? WARM_TIME_BUDGET_MS : COLD_TIME_BUDGET_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, budgetMs);
      timer.unref?.();
    });

    const workPromise = (async (): Promise<Weather> => {
      let lat: number;
      let lon: number;
      let placeName = parsed.displayPlace;
      let assumedPlace = parsed.assumedDefault;

      if (parsed.isCoords) {
        lat = parsed.lat!;
        lon = parsed.lon!;
      } else if (parsed.builtinHit) {
        lat = parsed.builtinHit.lat;
        lon = parsed.builtinHit.lon;
        placeName = parsed.builtinHit.name;
      } else {
        let resolved: GeoInfo | null = null;
        for (const candidate of parsed.candidates) {
          const candKey = normalizePlaceKey(candidate);
          const cachedGeo = geocodeCache.get(candKey);
          if (cachedGeo) {
            resolved = cachedGeo;
            break;
          }

          const geoUrl = `${GEOCODE_ENDPOINT}?name=${encodeURIComponent(candidate)}&count=1&language=en&format=json`;
          const geoJson = (await fetchJsonWithSignal(
            fetchFn,
            geoUrl,
            controller.signal,
          )) as GeocodeApiResponse | null;

          const first = Array.isArray(geoJson?.results) ? geoJson.results[0] : undefined;
          const geoLat = finiteNumber(first?.latitude);
          const geoLon = finiteNumber(first?.longitude);
          if (first && geoLat !== null && geoLon !== null) {
            const name =
              typeof first.name === 'string' && first.name.trim().length > 0
                ? first.name.trim()
                : candidate;
            resolved = { name, lat: geoLat, lon: geoLon };
            geocodeCache.set(candKey, resolved);
            break;
          }
        }

        if (resolved) {
          lat = resolved.lat;
          lon = resolved.lon;
          placeName = resolved.name;
        } else {
          // Nothing resolved: fall back to default place (New York) and mark assumed_place.
          lat = DEFAULT_COORDS.lat;
          lon = DEFAULT_COORDS.lon;
          placeName = DEFAULT_COORDS.name;
          assumedPlace = true;
        }
      }

      const resolvedCacheKey = cacheKeyForGeo(placeName, parsed.isCoords, lat, lon, dateStr);
      const cachedAfterResolve = getCachedWeather(resolvedCacheKey, nowMs, startPerf, assumedPlace);
      if (cachedAfterResolve) {
        return cachedAfterResolve;
      }

      const forecastParams = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        daily:
          'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max',
        hourly: 'temperature_2m',
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        timezone: 'auto',
        start_date: dateStr,
        end_date: dateStr,
      });
      const forecastUrl = `${FORECAST_ENDPOINT}?${forecastParams.toString()}`;
      const forecastJson = (await fetchJsonWithSignal(
        fetchFn,
        forecastUrl,
        controller.signal,
      )) as ForecastApiResponse | null;

      const daily = forecastJson?.daily;
      if (!daily || !Array.isArray(daily.time) || daily.time.length === 0) {
        return noneWeather(placeName, dateStr, startPerf);
      }

      const dayIdx = Math.max(0, daily.time.indexOf(dateStr));
      const rawHigh = finiteNumber(daily.temperature_2m_max?.[dayIdx]);
      const rawLow = finiteNumber(daily.temperature_2m_min?.[dayIdx]);
      const rawWind = finiteNumber(daily.wind_speed_10m_max?.[dayIdx]);
      const rawRain = finiteNumber(daily.precipitation_probability_max?.[dayIdx]);
      const wmoCode = finiteNumber(daily.weather_code?.[dayIdx]);

      const high_f = rawHigh !== null ? Math.round(rawHigh) : null;
      const low_f = rawLow !== null ? Math.round(rawLow) : null;
      const wind_mph = rawWind !== null ? Math.round(rawWind) : null;
      const rain_chance =
        rawRain !== null ? Math.max(0, Math.min(100, Math.round(rawRain))) : null;

      // Hourly 19:00 local temperature, falling back to day's mean
      let temp_f: number | null = null;
      let hasEveningTemp = false;
      const hourlyTimes = forecastJson?.hourly?.time;
      const hourlyTemps = forecastJson?.hourly?.temperature_2m;

      if (Array.isArray(hourlyTimes) && Array.isArray(hourlyTemps)) {
        const targetHour = `${dateStr}T19:00`;
        const idx = hourlyTimes.findIndex(
          (t) => typeof t === 'string' && (t === targetHour || t.endsWith('T19:00')),
        );
        const eveningVal = idx >= 0 ? finiteNumber(hourlyTemps[idx]) : null;
        if (eveningVal !== null) {
          temp_f = Math.round(eveningVal);
          hasEveningTemp = true;
        } else {
          let sum = 0;
          let count = 0;
          for (const v of hourlyTemps) {
            const n = finiteNumber(v);
            if (n !== null) {
              sum += n;
              count += 1;
            }
          }
          if (count > 0) {
            temp_f = Math.round(sum / count);
          }
        }
      }

      if (temp_f === null) {
        if (high_f !== null && low_f !== null) {
          temp_f = Math.round((high_f + low_f) / 2);
        } else {
          temp_f = high_f ?? low_f;
        }
      }

      const baseCondition = wmoToCondition(wmoCode);
      const isWindy = wind_mph !== null && wind_mph >= WINDY_THRESHOLD_MPH;
      const conditions = isWindy
        ? baseCondition
          ? `windy and ${baseCondition}`
          : 'windy'
        : baseCondition;

      const line = buildForecastLine({
        place: placeName,
        isCoords: parsed.isCoords,
        target: targetYmd,
        deltaDays,
        temp_f,
        hasEveningTemp,
        high_f,
        low_f,
        baseCondition,
        wmoCode,
        wind_mph,
        rain_chance,
      });

      const weather: Weather = {
        ok: true,
        source: 'forecast',
        place: placeName,
        date: dateStr,
        temp_f,
        high_f,
        low_f,
        conditions,
        wind_mph,
        rain_chance,
        line,
        ms: elapsedMs(startPerf),
        ...(assumedPlace ? { assumed_place: true } : {}),
      };

      storeCachedWeather(resolvedCacheKey, nowMs, weather);
      return weather;
    })();

    // Prevent unhandled rejection if timeout wins the race before workPromise settles
    workPromise.catch(() => {});

    let result: Weather | null;
    try {
      result = await Promise.race([workPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (!result) {
      return noneWeather(parsed.displayPlace, dateStr, startPerf);
    }

    return result;
  } catch {
    const safeDate = (() => {
      try {
        return resolveDate(when, opts?.now);
      } catch {
        return formatYmd(dateToNyYmd(new Date()));
      }
    })();
    const safePlace = typeof where === 'string' ? normalizeCityName(where) : '';
    return noneWeather(safePlace, safeDate, startPerf);
  }
}
