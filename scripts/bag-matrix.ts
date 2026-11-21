import type { Gender } from '../src/types.ts';
import {
  STORES,
  search,
  getProduct,
  sizeVariant,
  matchSizeLabel,
} from '../src/store/index.ts';

interface SlotSpec {
  slot: string;
  query: string;
  asked: string[];
}

const SLOTS_BY_GENDER: Record<Gender, SlotSpec[]> = {
  men: [
    { slot: 'top', query: "men's shirt", asked: ['Large'] },
    { slot: 'bottom', query: "men's pants", asked: ['34'] },
    { slot: 'shoes', query: "men's shoes", asked: ['size 11'] },
    { slot: 'layer', query: "men's jacket", asked: ['Large'] },
  ],
  women: [
    { slot: 'top', query: "women's top", asked: ['Medium', '8'] },
    { slot: 'bottom', query: "women's jeans", asked: ['8', '28'] },
    { slot: 'shoes', query: "women's heels", asked: ['8'] },
    { slot: 'dress', query: "women's midi dress", asked: ['Medium'] },
    { slot: 'layer', query: "women's jacket", asked: ['Medium'] },
  ],
};

interface MatrixRow {
  store: string;
  dept: Gender;
  slot: string;
  title: string;
  sizeOptsSummary: string;
  asked: string;
  matched: string | null;
  ok: boolean;
  reason: string;
  hasAvailableSizes: boolean;
  isGenuineSoldOut: boolean;
  rawOptions: Array<{ name: string; labels: string[]; available: string[] }>;
}

function truncate(s: string, len: number): string {
  return s.length > len ? `${s.slice(0, len - 1)}…` : s.padEnd(len);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const rows: MatrixRow[] = [];

  const tasks: Array<{ storeName: string; site: string; dept: Gender; spec: SlotSpec }> = [];
  for (const store of STORES) {
    for (const dept of ['men', 'women'] as const) {
      for (const spec of SLOTS_BY_GENDER[dept]) {
        tasks.push({ storeName: store.name, site: store.site, dept, spec });
      }
    }
  }

  // Run with moderate concurrency so we stay well within Shop MCP limits
  let idx = 0;
  const WORKER_COUNT = 4;

  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      const { storeName, site, dept, spec } = tasks[i];

      const searchRes = await search(spec.query, dept, { shops: [site], limit: 4 });
      const item = searchRes.items[0];
      if (!item) continue;

      const detail = await getProduct(item.variant_id);
      if (!detail) continue;

      const sizeOptions = detail.options.filter((o) => /size|waist|length|inseam/i.test(o.name));
      const primarySizeOpt =
        detail.options.find((o) => /size/i.test(o.name)) ??
        detail.options.find((o) => /waist/i.test(o.name));

      // Skip quietly if a footwear-only store returned a shoe for a non-shoe clothing slot
      if (
        spec.slot !== 'shoes' &&
        primarySizeOpt &&
        /shoe/i.test(primarySizeOpt.name) &&
        sizeOptions.every((o) => /shoe/i.test(o.name))
      ) {
        continue;
      }

      const rawOptions = sizeOptions.map((o) => ({
        name: o.name,
        labels: o.values.map((v) => v.label),
        available: o.values.filter((v) => v.available).map((v) => v.label),
      }));

      const sizeOptsSummary =
        rawOptions.length > 0
          ? rawOptions
              .map((o) => `${o.name}:[${o.labels.slice(0, 8).join(',')}${o.labels.length > 8 ? ',…' : ''}]`)
              .join(' + ')
          : '(no size option)';

      const isTrueOneSize =
        !primarySizeOpt ||
        primarySizeOpt.values.length === 0 ||
        (primarySizeOpt.values.length === 1 &&
          /^(?:one\s*size|o\.?\/?s\.?|osfa|osfm|free\s*size|uni(?:sex)?|standard|default)$/i.test(
            primarySizeOpt.values[0].label.trim(),
          ));

      if (isTrueOneSize) {
        rows.push({
          store: storeName,
          dept,
          slot: spec.slot,
          title: item.title,
          sizeOptsSummary,
          asked: spec.asked[0],
          matched: primarySizeOpt?.values[0]?.label ?? '(one-size)',
          ok: detail.variant.available,
          reason: detail.variant.available ? '' : 'sold out',
          hasAvailableSizes: detail.variant.available,
          isGenuineSoldOut: !detail.variant.available,
          rawOptions,
        });
        continue;
      }

      const allLabels = primarySizeOpt.values.map((v) => v.label);
      const availLabels = primarySizeOpt.values.filter((v) => v.available).map((v) => v.label);

      for (const asked of spec.asked) {
        const matched = matchSizeLabel(asked, allLabels, {
          slot: spec.slot,
          gender: dept,
          available: availLabels,
        });

        let ok = false;
        let reason = '';
        let isGenuineSoldOut = false;

        if (!matched) {
          reason = `${asked} isn't in stock (sizes left: ${availLabels.slice(0, 12).join(', ')})`;
          // Store drops sold-out sizes from options; classify as sold-out when no matching size is left
          isGenuineSoldOut = true;
        } else {
          const sv = await sizeVariant(item.variant_id, matched, { gender: dept });
          ok = sv.ok;
          reason = sv.reason ?? '';
          if (!sv.ok && sv.available === false && /sold out/i.test(reason)) {
            isGenuineSoldOut = true;
          }
        }

        rows.push({
          store: storeName,
          dept,
          slot: spec.slot,
          title: item.title,
          sizeOptsSummary,
          asked,
          matched,
          ok,
          reason,
          hasAvailableSizes: availLabels.length > 0,
          isGenuineSoldOut,
          rawOptions,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: WORKER_COUNT }, () => worker()));

  rows.sort((a, b) =>
    `${a.store}|${a.dept}|${a.slot}|${a.asked}`.localeCompare(
      `${b.store}|${b.dept}|${b.slot}|${b.asked}`,
    ),
  );

  console.log('\n=== BAG SIZE MATRIX (LIVE) ===');
  console.log(
    'STORE        | DEPT  | SLOT   | TITLE                          | ASKED   | MATCHED    | OK    | OPTIONS & REASON',
  );
  console.log(
    '-------------+-------+--------+--------------------------------+---------+------------+-------+-----------------------------------------',
  );
  for (const r of rows) {
    console.log(
      `${r.store.padEnd(12)} | ${r.dept.padEnd(5)} | ${r.slot.padEnd(6)} | ${truncate(r.title, 30)} | ${r.asked.padEnd(7)} | ${(r.matched ?? 'null').padEnd(10)} | ${String(r.ok).padEnd(5)} | ${r.sizeOptsSummary}${r.reason ? ` => ${r.reason}` : ''}`,
    );
  }

  const failures = rows.filter((r) => !r.ok);
  const nonSoldOutFailures = failures.filter((r) => !r.isGenuineSoldOut);

  console.log(`\nTotal cases: ${rows.length}, passed: ${rows.length - failures.length}, failed: ${failures.length} (sold-out: ${failures.length - nonSoldOutFailures.length}, match/select issues: ${nonSoldOutFailures.length}) in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  if (failures.length > 0) {
    console.log('\n=== FAILURE LIST ===');
    for (const f of failures) {
      const tag = f.isGenuineSoldOut ? '[SOLD OUT]' : '[FIX NEEDED]';
      console.log(
        `${tag} ${f.store} | ${f.dept} ${f.slot} | "${f.title}" | asked="${f.asked}" matched="${f.matched}" | options=${JSON.stringify(f.rawOptions)} | reason="${f.reason}"`,
      );
    }
  }
}

main().catch((err) => {
  console.error('[bag:matrix] fatal:', err);
  process.exitCode = 1;
});
