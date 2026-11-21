// Copies the browser build of livekit-client into public/vendor/ so the page can import it
// with no bundler and no CDN (venue Wi-Fi is not something to depend on in a demo).
// Runs after every `npm install`. public/vendor/ is gitignored.
import { copyFileSync, mkdirSync } from 'node:fs';

const from = new URL('../node_modules/livekit-client/dist/livekit-client.esm.mjs', import.meta.url);
const toDir = new URL('../public/vendor/', import.meta.url);

try {
  mkdirSync(toDir, { recursive: true });
  copyFileSync(from, new URL('livekit-client.esm.mjs', toDir));
  console.log('vendor: copied livekit-client into public/vendor/');
} catch (err) {
  console.warn('vendor: could not copy livekit-client (run npm install again):', err.message);
}
