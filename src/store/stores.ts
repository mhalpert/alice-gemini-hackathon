export interface CuratedStore {
  name: string;
  site: string;
  shop: string;
}

export const STORES: readonly CuratedStore[] = [
  { name: 'Fashion Nova', site: 'fashionnova.com', shop: 'fnova.myshopify.com' },
  { name: 'Everlane', site: 'everlane.com', shop: 'm34kzg-ke.myshopify.com' },
  { name: 'Steve Madden', site: 'stevemadden.com', shop: 'stevemadden.myshopify.com' },
  { name: 'Kith', site: 'kith.com', shop: 'kithnyc.myshopify.com' },
];

export const ALL_SITES: string[] = STORES.map((s) => s.site);

export const OTHER_SITES: string[] = STORES.filter((s) => s.site !== 'fashionnova.com').map(
  (s) => s.site,
);

function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      // fall through to manual cleanup
    }
  }
  host = host.split('/')[0] ?? host;
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }
  return host;
}

export function storeNameForDomain(
  domain: string | null | undefined,
  fallbackName?: string,
): string {
  if (domain) {
    const normalized = normalizeHost(domain);
    const match = STORES.find(
      (s) =>
        s.shop.toLowerCase() === normalized ||
        s.site.toLowerCase() === normalized ||
        normalized.endsWith(`.${s.site.toLowerCase()}`),
    );
    if (match) return match.name;
  }
  if (fallbackName && fallbackName.trim()) {
    return fallbackName.trim();
  }
  return domain?.trim() || 'Unknown Store';
}
