import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearWeatherCache, forecast, resolveDate, warmWeather } from '../src/weather.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeGeocodeFixture(name = 'Denver', lat = 39.7392, lon = -104.9903) {
  return {
    results: [
      {
        id: 5419384,
        name,
        latitude: lat,
        longitude: lon,
        timezone: 'America/Denver',
      },
    ],
    generationtime_ms: 0.3,
  };
}

function makeForecastFixture(
  date: string,
  overrides: {
    high?: number;
    low?: number;
    rain?: number;
    wmo?: number;
    wind?: number;
    eveningTemp?: number | null;
    hourlyTemps?: number[];
  } = {},
) {
  const high = overrides.high ?? 52.2;
  const low = overrides.low ?? 41.1;
  const rain = overrides.rain ?? 10;
  const wmo = overrides.wmo ?? 3;
  const wind = overrides.wind ?? 18.4;

  const times: string[] = [];
  const temps: number[] = [];
  if (overrides.hourlyTemps) {
    for (let h = 0; h < overrides.hourlyTemps.length; h++) {
      times.push(`${date}T${String(h).padStart(2, '0')}:00`);
      temps.push(overrides.hourlyTemps[h]!);
    }
  } else {
    for (let h = 0; h < 24; h++) {
      if (h === 19 && overrides.eveningTemp === null) continue;
      times.push(`${date}T${String(h).padStart(2, '0')}:00`);
      temps.push(h === 19 ? (overrides.eveningTemp ?? 48.3) : 46);
    }
  }

  return {
    latitude: 40.71,
    longitude: -73.99,
    timezone: 'America/New_York',
    hourly: {
      time: times,
      temperature_2m: temps,
    },
    daily: {
      time: [date],
      temperature_2m_max: [high],
      temperature_2m_min: [low],
      precipitation_probability_max: [rain],
      weather_code: [wmo],
      wind_speed_10m_max: [wind],
    },
  };
}

beforeEach(() => {
  clearWeatherCache();
});

describe('resolveDate', () => {
  // Wednesday, 2026-11-18 15:00 EST (20:00 UTC)
  const wednesday = new Date('2026-11-18T20:00:00Z');
  // Saturday, 2026-11-21 11:30 EST (16:30 UTC)
  const saturday = new Date('2026-11-21T16:30:00Z');
  // Sunday, 2026-11-22 10:00 EST (15:00 UTC)
  const sunday = new Date('2026-11-22T15:00:00Z');
  // Friday, 2026-11-20 12:00 EST (17:00 UTC)
  const friday = new Date('2026-11-20T17:00:00Z');
  // Late evening in NY: 2026-11-21 22:30 EST = 2026-11-22 03:30 UTC
  const lateSaturdayNy = new Date('2026-11-22T03:30:00Z');

  const cases: Array<{ label: string; when: string | Date | undefined; now: Date; expected: string }> = [
    { label: 'missing -> today', when: undefined, now: wednesday, expected: '2026-11-18' },
    { label: 'empty string -> today', when: '   ', now: wednesday, expected: '2026-11-18' },
    { label: 'unparseable -> today', when: 'sometime soonish', now: wednesday, expected: '2026-11-18' },
    { label: 'invalid calendar YYYY-MM-DD -> today', when: '2026-02-30', now: wednesday, expected: '2026-11-18' },
    { label: 'valid YYYY-MM-DD', when: '2026-12-05', now: wednesday, expected: '2026-12-05' },
    { label: 'Date instance in America/New_York', when: new Date('2026-11-25T18:00:00Z'), now: wednesday, expected: '2026-11-25' },
    { label: 'invalid Date -> today', when: new Date('invalid'), now: wednesday, expected: '2026-11-18' },
    { label: 'NY timezone across UTC midnight', when: 'today', now: lateSaturdayNy, expected: '2026-11-21' },
    { label: 'today', when: 'today', now: wednesday, expected: '2026-11-18' },
    { label: 'tonight', when: 'tonight', now: wednesday, expected: '2026-11-18' },
    { label: 'tomorrow', when: 'tomorrow', now: wednesday, expected: '2026-11-19' },
    { label: 'Saturday from Wednesday', when: 'Saturday', now: wednesday, expected: '2026-11-21' },
    { label: 'this Saturday from Wednesday', when: 'this Saturday', now: wednesday, expected: '2026-11-21' },
    { label: 'this Saturday when today is Saturday', when: 'this Saturday', now: saturday, expected: '2026-11-21' },
    { label: 'Saturday night from Wednesday', when: 'Saturday night', now: wednesday, expected: '2026-11-21' },
    { label: 'Saturday evening from Wednesday', when: 'Saturday evening', now: wednesday, expected: '2026-11-21' },
    { label: 'Saturday when today is Saturday (today counts)', when: 'Saturday', now: saturday, expected: '2026-11-21' },
    { label: 'Saturday from Sunday', when: 'Saturday', now: sunday, expected: '2026-11-28' },
    { label: 'Wednesday when today is Wednesday (today counts)', when: 'Wednesday', now: wednesday, expected: '2026-11-18' },
    { label: 'Monday from Saturday', when: 'Monday', now: saturday, expected: '2026-11-23' },
    { label: 'next Friday from Wednesday', when: 'next Friday', now: wednesday, expected: '2026-11-27' },
    { label: 'next Friday from Friday', when: 'next Friday', now: friday, expected: '2026-11-27' },
    { label: 'next Friday from Saturday', when: 'next Friday', now: saturday, expected: '2026-11-27' },
    { label: 'next Saturday from Saturday', when: 'next Saturday', now: saturday, expected: '2026-11-28' },
    { label: 'this weekend from Wednesday -> Saturday', when: 'this weekend', now: wednesday, expected: '2026-11-21' },
    { label: 'this weekend from Saturday -> today', when: 'this weekend', now: saturday, expected: '2026-11-21' },
    { label: 'this weekend from Sunday -> next Saturday', when: 'this weekend', now: sunday, expected: '2026-11-28' },
    { label: 'in 14 days', when: 'in 14 days', now: saturday, expected: '2026-12-05' },
  ];

  for (const c of cases) {
    test(c.label, () => {
      assert.equal(resolveDate(c.when, c.now), c.expected);
    });
  }
});

describe('forecast', () => {
  const wednesday = new Date('2026-11-18T17:00:00Z'); // 2026-11-18 12:00 EST

  test('built-in table hit (New York, this Saturday) makes exactly one fetch without geocoding', async () => {
    const requestedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
        return jsonResponse(
          makeForecastFixture('2026-11-21', {
            high: 52.2,
            low: 41.1,
            eveningTemp: 48.3,
            wind: 18.4,
            rain: 10,
            wmo: 3,
          }),
        );
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const result = await forecast('New York', 'this Saturday', { now: wednesday, fetch: mockFetch });

    assert.equal(requestedUrls.length, 1);
    assert.ok(requestedUrls[0]!.startsWith('https://api.open-meteo.com/v1/forecast?'));
    assert.ok(requestedUrls[0]!.includes('start_date=2026-11-21'));
    assert.ok(requestedUrls[0]!.includes('end_date=2026-11-21'));
    assert.ok(requestedUrls[0]!.includes('temperature_unit=fahrenheit'));
    assert.ok(requestedUrls[0]!.includes('wind_speed_unit=mph'));

    assert.equal(result.ok, true);
    assert.equal(result.source, 'forecast');
    assert.equal(result.place, 'New York');
    assert.equal(result.assumed_place, undefined);
    assert.equal(result.date, '2026-11-21');
    assert.equal(result.temp_f, 48);
    assert.equal(result.high_f, 52);
    assert.equal(result.low_f, 41);
    assert.equal(result.conditions, 'windy and overcast');
    assert.equal(result.wind_mph, 18);
    assert.equal(result.rain_chance, 10);
    assert.equal(
      result.line,
      'Saturday in New York: about 48°F in the evening, overcast, windy (18 mph), 10% chance of rain; high 52, low 41.',
    );
    assert.equal(typeof result.ms, 'number');
    assert.ok(result.ms >= 0);
  });

  test('extracts date from combined place string ("New York / this Saturday" and "Miami tomorrow")', async () => {
    const requestedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('start_date=2026-11-21')) {
        return jsonResponse(
          makeForecastFixture('2026-11-21', { high: 55, low: 42, eveningTemp: 49, wind: 8, rain: 0, wmo: 1 }),
        );
      }
      if (url.includes('start_date=2026-11-19')) {
        return jsonResponse(
          makeForecastFixture('2026-11-19', { high: 80, low: 68, eveningTemp: 74, wind: 10, rain: 20, wmo: 2 }),
        );
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const ny = await forecast('New York / this Saturday', undefined, { now: wednesday, fetch: mockFetch });
    assert.equal(ny.ok, true);
    assert.equal(ny.place, 'New York');
    assert.equal(ny.date, '2026-11-21');
    assert.equal(ny.assumed_place, undefined);
    assert.equal(
      ny.line,
      'Saturday in New York: about 49°F in the evening, mostly clear; high 55, low 42.',
    );

    const miami = await forecast('Miami tomorrow', undefined, { now: wednesday, fetch: mockFetch });
    assert.equal(miami.ok, true);
    assert.equal(miami.place, 'Miami');
    assert.equal(miami.date, '2026-11-19');
    assert.equal(miami.assumed_place, undefined);
    assert.equal(
      miami.line,
      'Tomorrow in Miami: about 74°F in the evening, partly cloudy, 20% chance of rain; high 80, low 68.',
    );
    assert.equal(requestedUrls.length, 2);
  });

  test('strips venue words from messy place string ("Brooklyn rooftop", "Saturday night") and hits table in one fetch', async () => {
    const requestedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
        return jsonResponse(
          makeForecastFixture('2026-11-21', { high: 54, low: 43, eveningTemp: 47, wind: 9, rain: 15, wmo: 2 }),
        );
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const result = await forecast('Brooklyn rooftop', 'Saturday night', {
      now: wednesday,
      fetch: mockFetch,
    });

    assert.equal(requestedUrls.length, 1);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'forecast');
    assert.equal(result.place, 'Brooklyn');
    assert.equal(result.date, '2026-11-21');
    assert.equal(result.assumed_place, undefined);
    assert.equal(
      result.line,
      'Saturday in Brooklyn: about 47°F in the evening, partly cloudy, 15% chance of rain; high 54, low 43.',
    );
  });

  test('falls back to daily mean when 19:00 hourly value is missing and assumes New York for empty place', async () => {
    const requestedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      return jsonResponse(
        makeForecastFixture('2026-11-18', {
          high: 60,
          low: 40,
          eveningTemp: null,
          hourlyTemps: [45, 55],
          wind: 8,
          rain: 0,
          wmo: 0,
        }),
      );
    };

    const result = await forecast('   ', undefined, { now: wednesday, fetch: mockFetch });
    assert.equal(requestedUrls.length, 1);
    assert.equal(result.ok, true);
    assert.equal(result.place, 'New York');
    assert.equal(result.assumed_place, true);
    assert.equal(result.temp_f, 50);
    assert.equal(result.conditions, 'clear');
    assert.equal(result.line, 'Today in New York: around 50°F, clear; high 60, low 40.');
  });

  test('unknown place misses geocoder, falls back to New York with assumed_place: true and ok: true', async () => {
    const requestedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('geocoding-api')) {
        return jsonResponse({ generationtime_ms: 0.2 });
      }
      if (url.includes('api.open-meteo.com/v1/forecast')) {
        return jsonResponse(
          makeForecastFixture('2026-11-18', {
            high: 58,
            low: 44,
            eveningTemp: 50,
            wind: 7,
            rain: 0,
            wmo: 1,
          }),
        );
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const result = await forecast('Zxqvkjblarg', 'today', { now: wednesday, fetch: mockFetch });
    assert.equal(requestedUrls.length, 2);
    assert.ok(requestedUrls[0]!.includes('geocoding-api'));
    assert.ok(requestedUrls[1]!.includes('latitude=40.7128'));
    assert.equal(result.ok, true);
    assert.equal(result.source, 'forecast');
    assert.equal(result.place, 'New York');
    assert.equal(result.assumed_place, true);
    assert.equal(
      result.line,
      'Today in New York: about 50°F in the evening, mostly clear; high 58, low 44.',
    );

    // Subsequent explicit New York call uses cache without leaking assumed_place
    const explicitNy = await forecast('New York', 'today', { now: wednesday, fetch: mockFetch });
    assert.equal(requestedUrls.length, 2);
    assert.equal(explicitNy.ok, true);
    assert.equal(explicitNy.assumed_place, undefined);
  });

  test('tries cleaned text, first two words, then first word against geocoder for unlisted cities', async () => {
    const geocodedNames: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('geocoding-api')) {
        const parsed = new URL(url);
        const name = parsed.searchParams.get('name') ?? '';
        geocodedNames.push(name);
        if (name === 'Santa Barbara') {
          return jsonResponse(makeGeocodeFixture('Santa Barbara', 34.4208, -119.6982));
        }
        return jsonResponse({ generationtime_ms: 0.2 });
      }
      return jsonResponse(
        makeForecastFixture('2026-11-18', { high: 70, low: 55, eveningTemp: 64, wind: 6, rain: 0, wmo: 0 }),
      );
    };

    const result = await forecast('Santa Barbara vineyard dinner', 'today', {
      now: wednesday,
      fetch: mockFetch,
    });
    assert.deepEqual(geocodedNames, ['Santa Barbara vineyard dinner', 'Santa Barbara']);
    assert.equal(result.ok, true);
    assert.equal(result.place, 'Santa Barbara');
    assert.equal(result.assumed_place, undefined);
  });

  test('fetch rejection never throws and returns ok: false, source: none', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error('network down');
    };

    const result = await forecast('Miami', 'tomorrow', { now: wednesday, fetch: mockFetch });
    assert.equal(result.ok, false);
    assert.equal(result.source, 'none');
    assert.equal(result.line, '');
  });

  test('cold budget is 3.5 s (survives 1.8 s cold call), then warm budget is 1.5 s', async () => {
    // 1. Cold call takes 1.8s -> succeeds because cold budget is 3.5s
    const slowColdFetch: typeof fetch = async (_input, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            jsonResponse(
              makeForecastFixture('2026-11-21', {
                high: 55,
                low: 43,
                eveningTemp: 49,
                wind: 7,
                rain: 0,
                wmo: 1,
              }),
            ),
          );
        }, 1800);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const coldResult = await forecast('New York', 'this Saturday', {
      now: wednesday,
      fetch: slowColdFetch,
    });
    assert.equal(coldResult.ok, true);
    assert.equal(coldResult.source, 'forecast');
    assert.ok(coldResult.ms >= 1700 && coldResult.ms < 3000, `expected ~1800ms, got ${coldResult.ms}ms`);

    // 2. Module is now warm -> hanging call aborts at 1.5s
    let aborted = false;
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const warmResult = await forecast('Boston', 'today', { now: wednesday, fetch: hangingFetch });
    assert.equal(warmResult.ok, false);
    assert.equal(warmResult.source, 'none');
    assert.equal(warmResult.line, '');
    assert.equal(aborted, true);
    assert.ok(warmResult.ms >= 1400 && warmResult.ms < 2500, `expected ~1500ms, got ${warmResult.ms}ms`);
  });

  test('cold hanging fetch aborts at 3.5 s budget and never throws', async () => {
    let aborted = false;
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const result = await forecast('Boston', 'today', { now: wednesday, fetch: hangingFetch });
    assert.equal(result.ok, false);
    assert.equal(result.source, 'none');
    assert.equal(result.line, '');
    assert.equal(aborted, true);
    assert.ok(result.ms >= 3400 && result.ms < 4500, `expected ~3500ms, got ${result.ms}ms`);
  });

  test('warmWeather primes cache in background and never throws', async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(
        makeForecastFixture('2026-11-18', { high: 61, low: 48, eveningTemp: 54, wind: 6, rain: 0, wmo: 0 }),
      );
    };

    const warmed = await warmWeather('New York', { now: wednesday, fetch: mockFetch });
    assert.equal(warmed.ok, true);
    assert.equal(calls, 1);

    const cached = await forecast('New York', 'today', { now: wednesday, fetch: mockFetch });
    assert.equal(cached.ok, true);
    assert.equal(calls, 1);

    const failFetch: typeof fetch = async () => {
      throw new Error('boom');
    };
    const failedWarm = await warmWeather('Boston', { now: wednesday, fetch: failFetch });
    assert.equal(failedWarm.ok, false);
  });

  test('12 days out returns season without any fetch call', async () => {
    let fetchCalls = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called');
    };

    // 12 days after 2026-11-18 = 2026-11-30
    const result = await forecast('Miami', '2026-11-30', { now: wednesday, fetch: mockFetch });
    assert.equal(fetchCalls, 0);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'season');
    assert.equal(result.date, '2026-11-30');
    assert.equal(result.temp_f, null);
    assert.ok(result.line.includes("That's too far out for a forecast"));
    assert.ok(result.line.includes('Miami'));

    // Early June in Miami -> hot and humid
    const juneMiami = await forecast('Miami', '2027-06-04', { now: wednesday, fetch: mockFetch });
    assert.equal(fetchCalls, 0);
    assert.equal(juneMiami.source, 'season');
    assert.equal(
      juneMiami.line,
      "That's too far out for a forecast; early June in Miami is usually hot and humid.",
    );

    // Southern hemisphere flipped (Sydney in January = hot, July = cool)
    const sydneyJan = await forecast('Sydney', '2027-01-15', { now: wednesday, fetch: mockFetch });
    const sydneyJul = await forecast('Sydney', '2027-07-15', { now: wednesday, fetch: mockFetch });
    assert.equal(fetchCalls, 0);
    assert.match(sydneyJan.conditions, /hot|warm/);
    assert.match(sydneyJul.conditions, /cool|cold/);

    // Tropics always warm
    const singaporeJan = await forecast('Singapore', '2027-01-15', { now: wednesday, fetch: mockFetch });
    const singaporeJul = await forecast('Singapore', '2027-07-15', { now: wednesday, fetch: mockFetch });
    assert.equal(fetchCalls, 0);
    assert.match(singaporeJan.conditions, /warm/);
    assert.match(singaporeJul.conditions, /warm/);

    // Past date -> season without any fetch call
    const past = await forecast('New York', '2026-11-10', { now: wednesday, fetch: mockFetch });
    assert.equal(fetchCalls, 0);
    assert.equal(past.source, 'season');
    assert.equal(past.ok, true);
  });

  test('cache hit makes no second fetch and expires after 10 minutes', async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes('geocoding-api')) {
        return jsonResponse(makeGeocodeFixture('Denver', 39.74, -104.99));
      }
      return jsonResponse(
        makeForecastFixture('2026-11-19', {
          high: 45,
          low: 33,
          eveningTemp: 39,
          wind: 12,
          rain: 30,
          wmo: 61,
        }),
      );
    };

    const first = await forecast('Denver', 'tomorrow', { now: wednesday, fetch: mockFetch });
    assert.equal(first.ok, true);
    assert.equal(first.conditions, 'light rain');
    assert.equal(calls, 2);

    // Second call 5 minutes later with different casing -> cache hit
    const fiveMinLater = new Date(wednesday.getTime() + 5 * 60 * 1000);
    const second = await forecast('  denver ', '2026-11-19', {
      now: fiveMinLater,
      fetch: mockFetch,
    });
    assert.equal(second.ok, true);
    assert.equal(second.line, first.line);
    assert.equal(calls, 2);

    // Third call 11 minutes later -> cache expired (forecast refetched; geocode cached)
    const elevenMinLater = new Date(wednesday.getTime() + 11 * 60 * 1000);
    const third = await forecast('Denver', '2026-11-19', {
      now: elevenMinLater,
      fetch: mockFetch,
    });
    assert.equal(third.ok, true);
    assert.equal(calls, 3);
  });

  test('coordinates skip geocoding and call forecast directly', async () => {
    const urls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      return jsonResponse(
        makeForecastFixture('2026-11-18', {
          high: 75,
          low: 62,
          eveningTemp: 70,
          wind: 6,
          rain: 0,
          wmo: 1,
        }),
      );
    };

    const result = await forecast({ lat: 34.0522, lon: -118.2437 }, 'today', {
      now: wednesday,
      fetch: mockFetch,
    });

    assert.equal(urls.length, 1);
    assert.ok(urls[0]!.startsWith('https://api.open-meteo.com/v1/forecast?'));
    assert.ok(urls[0]!.includes('latitude=34.0522'));
    assert.ok(urls[0]!.includes('longitude=-118.2437'));
    assert.equal(result.ok, true);
    assert.equal(result.source, 'forecast');
    assert.equal(result.place, '34.05, -118.24');
    assert.equal(result.temp_f, 70);
    assert.equal(result.conditions, 'mostly clear');
    assert.equal(result.line, 'Today: about 70°F in the evening, mostly clear; high 75, low 62.');
  });
});
