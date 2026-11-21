// Shared types for every track. Import from here; never rename or remove a field.
// A change has to be additive and announced in the team chat before it merges.
// Field names are snake_case. Prices are US dollars (the store layer converts from cents).

export type Gender = 'men' | 'women';

export interface Item {
  id: string;                 // product id from the store catalog
  variant_id: string;         // the chosen variant; carts and product lookups use this one
  title: string;
  price: number;              // US dollars
  url: string;                // the product's page on the store's site
  image: string;              // store CDN image URL with no width parameter
  store: string;              // display name: 'Fashion Nova' | 'Everlane' | 'Steve Madden' | 'Kith'
  store_domain: string;       // the seller's shop host; cart creation needs it
  rating: number | null;
  rating_count: number | null;
  sizes: string[];            // size labels in stock, when known
  variants_by_size: Record<string, string>; // size label -> variant id
  description: string;        // plain text, roughly 300 characters
  department: Gender;
}

// slot is one of: top | bottom | dress | layer | shoes | accessory | bag | jewelry
export interface Piece { slot: string; why: string; item: Item }

export interface Outfit { number?: number; name: string; difference: string; story: string; pieces: Piece[]; total: number }

export interface Brief { gender: Gender; occasion: string; budget_usd: number; notes?: string; own_piece?: string; weather?: string }

export interface BuildResult { outfits: Outfit[]; source: 'library' | 'live' | 'mixed'; timing: { first_outfit_ms: number; total_ms: number }; problems: string[] }

export interface SearchResult { items: Item[]; source: 'live' | 'saved' | 'saved-near' | 'empty'; ms: number }

export interface CartResult {
  store: string; store_domain: string; cart_id: string | null; continue_url: string | null; total_usd: number | null;
  added: { variant_id: string; title?: string; size?: string | null }[];
  not_added: { variant_id: string; title?: string; reason: string }[]; // reason is a short sentence the shopper can hear
  ms: number;
}

export interface BagOut { carts: CartResult[]; summary: string; total_usd: number }

// ---------------------------------------------------------------------------
// Page actions: what the agent sends to the call page over LiveKit RPC.
// The RPC method name is the action name and the payload is JSON under 15 KiB.
// `outfit` is always the look number (1, 2 or 3). A piece is named by its slot.
// Every handler answers with a PageActionReply and never throws to the agent.
// ---------------------------------------------------------------------------

export type TryOnState = 'rendering' | 'ready' | 'failed';

// One line in the bag. `reason` is set only on lines that were not added.
export interface BagLine { title: string; slot: string; image: string; price: number; size?: string | null; reason?: string }
export interface BagStore { store: string; added: BagLine[]; not_added: BagLine[]; subtotal: number | null }
export interface BagLink { store: string; url: string }

// An order the shopper reviews before the agent places it. Labels are display text only:
// a payment label names the method ("Shop Pay, Visa ending 42"), never a number that could be used.
export type OrderStatus = 'review' | 'placing' | 'placed' | 'handoff' | 'failed';
export interface OrderStore {
  store: string; items: BagLine[]; total: number | null; payment_label: string | null; ready: boolean;
  status?: OrderStatus; order_number?: string; continue_url?: string; note?: string;
}
export interface OrderReview {
  order_id: string; stores: OrderStore[]; total: number | null; address_label?: string | null;
  needs_sign_in?: boolean; sign_in?: { url: string; code?: string };
}

// Where each piece sits on a flat-lay board: slot -> [x, y, width, height], each a fraction 0 to 1 of the image.
export type BoardBoxes = Record<string, [number, number, number, number]>;
// The renders of a look on the shopper: on white, in the occasion's setting, and a short clip.
export type TryOnKind = 'studio' | 'scene' | 'video';

export interface PageActions {
  showOutfits: { outfits: Outfit[]; replace?: boolean; subtitle?: string };
  highlight: { outfit: number; piece: string | null };      // null points at the whole look
  updateOutfit: { outfit: number; data: Outfit; slot?: string };
  tryOnStatus: { outfit: number; status: TryOnState };
  tryOnReady: { outfit: number; url: string; kind?: TryOnKind };   // no kind means the studio still
  collageReady: { outfit: number; url: string; boxes?: BoardBoxes };
  showAll: Record<string, never>;
  showOrderReview: { order: OrderReview };
  confirmOrder: { order_id: string };                         // reply adds confirmed: boolean
  orderPlaced: { order_id: string; stores: OrderStore[] };
  reveal: { outfit: number; url?: string; kind?: TryOnKind };
  bagReady: { stores: BagStore[]; links: BagLink[]; total: number };
  say: { caption: string };
  showSearch: { query: string; items: Item[]; title?: string; rack?: boolean }; // title replaces the "Results for" heading; rack shows up to 12 items
  showProduct: { item: Item; images: string[]; slot: string; why: string; sizes: string[]; details: string[]; description: string };
  hideProduct: Record<string, never>;
  showPiece: { outfit: number; slot: string; item: Item; image: string; index: number; count: number; note: string; point?: { x: number; y: number } };
  hidePiece: Record<string, never>;
}

export type PageActionName = keyof PageActions;

export interface PageActionReply { ok: boolean; error?: string }
