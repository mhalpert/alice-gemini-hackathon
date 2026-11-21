# Alice

Alice is an AI stylist you video-call before an occasion. You tell her where you are going
and what you want to spend. She builds outfits from real products in real Shopify stores,
shows them on a store page while she talks, puts the one you pick on a photo of you, and
fills a cart you can check out at the store.

Built at the Gemini 4 NYC Hackathon on Saturday, November 21, 2026.

## What a call looks like

1. You open the page and press Talk. Alice hears you and sees your camera.
2. You name the occasion and a budget. Three looks appear one at a time, each a full outfit
   of real products with prices that add up under the budget.
3. You pick a look. The page shows its flat lay and Alice walks through the pieces. You can
   swap a piece ("same shoes in brown", "a cheaper jacket").
4. You say "show me". A try-on image of you in the outfit fades in, followed by a still on
   location and a short video.
5. You give your sizes. Alice builds one cart per store, says plainly what could not be
   added and why, and the page links to each store's own checkout.

Nothing in the call is typed unless you want it to be. There is a "Type instead" box and a
mute key for loud rooms.

## Models and what each one does

| Model | Job in Alice | Code |
| --- | --- | --- |
| Gemini 4 Hydrogen | The stylist. Turns the occasion and budget into outfit ideas, then picks one real product for each slot from the store results. | `src/brain/plan.ts`, `src/brain/pick.ts` |
| Gemini 4 Argon | The critic. Looks at the finished outfit's product photos, scores it against dress-code rules and names the weakest piece. Also grades the ready-made looks. | `src/brain/critic.ts`, `src/library/grade.ts` |
| Gemini 4 Neon | The try-on inspector. Before a try-on is shown, it checks that the image is the same person wearing every listed piece, and sends it back for a redo if not. | `src/media/inspect.ts` |
| Decisions API (`gemini-decision-1`) | Yes or no questions answered with a probability. For an outfit: does it fit the occasion, and does it hang together. For a try-on: is it the same person, and are the colours right. | `src/brain/gate.ts`, `src/media/inspect.ts` |
| Gemini 3.8 Live | The call itself: listens, watches camera frames, speaks, and calls the tools that drive the page. | `src/agent/` |
| Gemini Nano Banana 2.1 | Draws the try-on image and the on-location still. | `src/media/tryon-render.ts`, `src/media/extras.ts` |
| Gemini Omni 1.2 Flash | Makes the short video of the picked look. | `src/media/extras.ts` |
| Gemini 3.5 Flash Lite | Backup planner when Hydrogen is slow, the piece swap, and choosing the cleanest product photo. | `src/brain/plan.ts`, `src/brain/swap.ts`, `src/media/shots.ts` |
| Gemini Embedding 001 | Matches the occasion you say to a ready-made look. | `src/library/` |

Products, prices, stock and carts come from the stores through Shop MCP (Fashion Nova,
Everlane, Steve Madden and Kith). Product and checkout links are passed through unchanged.
The call runs over LiveKit.

## Run it

You need Node 26, a Google API key with access to the models above, and a LiveKit project.

```sh
nvm use                      # Node 26, from .nvmrc
npm install
cp .env.example .env.local   # then fill in the Google and LiveKit values
npm start                    # the page and API, http://localhost:3000
ALICE_BRAIN=live npm run agent   # in a second terminal: Alice herself
```

Open `http://localhost:3000` and press Talk. Without `ALICE_BRAIN=live` the outfits come
from a small sample file instead of the live builder. `http://localhost:3000/?demo=1` plays
that sample through the page with no call, which is how the page was developed. It is not
part of the demo.

Keys live in `.env.local`, which git ignores. Set `ALICE_PASSCODE` before letting anything
but your own machine reach the page.

## Proof it works

Three layers, all in this repo.

**Unit tests.** `npm test` runs more than 400 tests with no network and no keys: the page
actions, sizing and bag rules, the planner's repair rules, the try-on checks, the call log
and the server's security rules.

**A graded call.** `npm run harness` opens the page in a headless browser and makes a real
call as a scripted shopper. A generated voice says nine lines over about four and a half
minutes (a rooftop birthday dinner, $300, pick the second look, show it on me, swap the
shoes for brown boots, sizes, bag it) against the real agent, the real stores and real
renders. It then reads the call log and grades seven checks: every expected tool ran, the
swap produced brown boots, the bag has the right sizes and pieces, Alice never claimed a bag
she did not build, no error events, no page errors, no late restart.

One-time setup is `npx playwright install chromium` and `npm run harness:media`. Then, with
the server and agent running, `npm run harness`.

The run on `main` at 1:57 PM on the day (commit `a54a8b4`):

```
=== Harness Report: alice-41579aa42d [PASS] ===
  [PASS] no_late_restart: no restart after 5s
  [PASS] no_error_events: no error-class events
  [PASS] no_page_error: no page_error events
  [PASS] expected_tools: all 7 expected tools ran once
  [PASS] swap_brown_shoes: shoes swapped to "Western Faux Suede Pull On Cowboy Boots - Brown"
  [PASS] bag_sizes_and_items: sizes matched (shoes=11, bottom=34, top=large)
  [PASS] no_false_bag_claim: no false bag claims after bag result
  Warnings:
    - not added (stock): Western Faux Suede Pull On Cowboy Boots - Brown (Fashion Nova): 11 isn't in stock (sizes left: 8, 9, 10)
  Timings:
    occasion -> first look on page: 1.86s
    occasion -> all three looks:    1.88s
    occasion -> try-on ready:       31.43s
    pick look 2 -> Alice 1st word:  1.31s
```

In the same call the on-location still arrived 14 seconds after the pick and the video 31
seconds after it, and the page showed each in turn.

**Outfit quality against a baseline.** The outfit pipeline (plan, search, pick, gate,
critic) is compared with a single model call given the same occasion, with Argon as the
judge. Results go here.

### Where it fails

- **The harness shopper is ours.** Its lines were written by the team and its camera shows a
  test pattern, not a person, so a harness pass says the plumbing works, not that a stranger's
  call will go well.
- **Earlier runs failed.** A run at about 1:45 PM failed on pacing: Alice held the whole bag
  back over one shoe size that was out of stock, and checked in on silence too often. A run on
  another laptop at 2:00 PM scored 6 of 7; the miss was the check itself reading the wrong
  field, and the bag was correct.
- **Try-on is slow.** About 30 seconds from the pick to the first image, and longer when the
  inspector sends an image back for a redo.
- **Stock.** A size that is sold out is reported and left out of the cart. Alice does not
  pick the nearest size for you.
- **Buying.** Alice fills the carts; you pay on each store's own checkout page. Placing the
  order inside the call is behind a switch that is off by default.
- **Ready-made looks.** For common occasions Alice starts from looks the builder prepared
  earlier in the day, re-checked for price and stock when served. Unusual occasions and
  budgets are built live and take longer.
- **Loud rooms.** Alice can mishear or get cut off; the typed box is the fallback.

## Built today

The repo was created on the morning of November 21, 2026 and everything in it was written
during the event. The ready-made looks in `src/library/sets.json` were generated that
afternoon by this repo's own builder from live store results.

## Where things are

| Folder | What is in it | Owner |
| --- | --- | --- |
| `src/agent/` | The voice agent, its tools and what it tells the page to show | Mike |
| `src/brain/`, `src/library/`, `eval/` | Outfit planning, picking, the critic, the ready-made looks | Jing |
| `src/store/`, `src/media/`, `server.ts` | Store search, carts, try-on and renders, the web server | Soham |
| `public/`, `src/types.ts` | The store page, the call layer, the shared types | Arjun |
| `scripts/harness/` | A scripted shopper that makes a real call and grades it | Mike |
| `tests/` | Unit tests (`npm test`) | Everyone |
