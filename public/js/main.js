// Page entry point: mounts the shop and the call layer and connects the two.
//   ?demo=1   plays the fixture through the same page-action handlers, with no call.

import { mountStore } from './store.js';
import { mountCall } from './call.js';
import { mountAccount } from './account.js';

let call;
const store = mountStore(document.getElementById('store'), {
  onTalk: () => call?.start(),
  isLive: () => Boolean(call?.isLive()),
  tellAlice: (text) => call?.sendText(text),
});
// Shopper accounts add one page action (saveMemory) and a masthead button; both do
// nothing unless the server has accounts switched on.
const account = mountAccount({ isLive: () => Boolean(call?.isLive()) });
const handlers = { ...store.handlers, ...account.handlers };
call = mountCall(document.getElementById('call'), { handlers });

const query = new URLSearchParams(location.search);
if (query.has('demo')) {
  call.preview();
  const { playDemo } = await import('./demo.js');
  playDemo({ ...handlers, say: call.say });
}

// Handy while developing: run a page action from the browser console.
window.alice = { handlers: { ...handlers, say: call.say }, call, account };
