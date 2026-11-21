// Internal capability symbol used to ensure `complete_checkout` can ONLY be invoked
// from `placeOrder`'s single inner completion step. Never re-export from `src/store/index.ts`.
export const COMPLETE_CHECKOUT_GUARD: unique symbol = Symbol('alice.complete_checkout.guard');
