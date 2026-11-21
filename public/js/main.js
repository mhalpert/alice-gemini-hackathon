// Page entry point: mounts the shop and the call layer and connects the two.
//   ?demo=1   plays the fixture through the same page-action handlers, with no call.

import { mountStore } from './store.js';
import { mountCall } from './call.js';

const store = mountStore(document.getElementById('store'));
const call = mountCall(document.getElementById('call'), { handlers: store.handlers });

const query = new URLSearchParams(location.search);
if (query.has('demo')) {
  call.preview();
  const { playDemo } = await import('./demo.js');
  playDemo({ ...store.handlers, say: call.say });
}

// Handy while developing: run a page action from the browser console.
window.alice = { handlers: { ...store.handlers, say: call.say }, call };
