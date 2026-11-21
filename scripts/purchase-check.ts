import { isPurchaseEnabled } from '../src/store/shopmcp.ts';
import { startSignIn, signOut } from '../src/store/auth.ts';

const wantsDeviceCode = process.argv.includes('--device-code');
const enabled = isPurchaseEnabled();

console.log(`ALICE_PURCHASE: ${enabled ? 'on' : 'off'}`);

if (wantsDeviceCode) {
  if (!enabled) {
    console.log('Skipping --device-code: ALICE_PURCHASE is not on.');
    process.exit(0);
  }
  const res = await startSignIn();
  if (res.error || !res.url) {
    console.error(`Device code request refused/failed: ${res.error ?? 'unknown error'}`);
    process.exit(1);
  }
  console.log(`Verification URL: ${res.url}`);
  if (res.code) {
    console.log(`User code: ${res.code}`);
  }
  console.log(`Expires in: ${res.expires_in_s}s`);
  // Harmless check only: clear pending poll so process exits cleanly without waiting for approval.
  signOut();
}
