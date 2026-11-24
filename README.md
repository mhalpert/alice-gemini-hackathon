# Alice

Alice is an AI stylist you video-call before an occasion. You tell her where you are going
and what you want to spend. She builds outfits from real products in real Shopify stores,
shows them on a store page while she talks, puts the one you pick on a photo of you, and
fills a cart you can check out at the store.

Built at the Gemini 4 NYC Hackathon on Saturday, November 21, 2026.

During judging it is live at https://alicestyles.me. It runs on a laptop at the event, so the
link works only while that laptop is up.

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

Nothing in the call is typed unless you want it to be. For loud rooms there is noise
cancellation on your audio, a "Type instead" box and a mute key. While a slow step runs,
Alice keeps talking in short lines, and she checks in if you go quiet. A video face for
Alice is optional (`AVATAR=tavus`) and off by default.

Without a call the page is still a store: choose an occasion from the dropdown or search for
one, add a ready-made look to the bag in your sizes, remove pieces, and check out at the store.
In a call Alice can also walk through a look one piece at a time, pointing at a detail.

## Models and what each one does

| Model | Job in Alice | Code |
| --- | --- | --- |
| Gemini 4 Hydrogen | The stylist. Turns the occasion and budget into outfit ideas, then picks one real product for each slot from the store results. | `src/brain/plan.ts`, `src/brain/pick.ts` |
| Gemini 4 Argon | The critic. Looks at the finished outfit's product photos, scores it against dress-code rules and names the weakest piece. Also grades the ready-made looks and judges the eval. | `src/brain/critic.ts`, `src/library/grade.ts` |
| Gemini 4 Neon | The try-on inspector. Before a try-on is shown, it checks that the image is the same person wearing every listed piece, and sends it back for a redo if not. | `src/media/inspect.ts` |
| Decisions API (`gemini-decision-1`) | Yes or no questions answered with a probability. For an outfit: does it fit the occasion, and does it hang together. For a try-on: is it the same person, and are the colours right. | `src/brain/gate.ts`, `src/media/inspect.ts` |
| Gemini 3.8 Live | The call itself: listens, watches camera frames, speaks, and calls the tools that drive the page. | `src/agent/` |
| Gemini Nano Banana 2.1 | Draws the try-on image and the on-location still. | `src/media/tryon-render.ts`, `src/media/extras.ts` |
| Gemini Omni 1.2 Flash | Makes the short video of the picked look. | `src/media/extras.ts` |
| Gemini 3.5 Flash Lite | Backup planner when Hydrogen is slow, rewriting a look's lines after a swap, and choosing the cleanest product photo. | `src/brain/plan.ts`, `src/brain/swap.ts`, `src/media/shots.ts` |
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

Four layers, all in this repo.

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

**Store and render checks.** One command each, run during the event by the back end track:

- `npm run drill`: the store rate-limited, slow, down, returning garbage or dropping
  connections. 8 of 8 pass: search falls back to saved results and the bag stays honest.
- `npm run bag:matrix`: 41 live size cases across the four stores. Every failure was a size
  that really was sold out.
- `npm run inspector:check`: 4 of 4 deliberately bad try-ons caught and fixed, 0 of 4 good
  ones flagged.
- `npm run callstats`: turns cut off, response times, render and bag timings from any call
  log.

**Outfit quality against a baseline.** The outfit pipeline (plan, search, pick, gate) is
compared with a baseline of one Flash Lite call that writes the search queries and takes
the top store result for each piece. Argon judges both, on 22 occasions (20 test-kit briefs
and the 2 demo briefs).

| | Pipeline | One-call baseline |
| --- | --- | --- |
| Average score out of 10 | 6.1 | 5.1 |
| Presentable sets | 13 of 22 | 3 of 22 |
| Dress-code breaks | 0 | 4 |
| Outfits over budget | 0 | 21 |
| Time to first look (median) | 16.3 s | 1.8 s |

A full build takes 18.9 seconds at the median and costs about 7 cents. On 5 deliberately
messy briefs the team wrote, kept out of the numbers above, the pipeline averaged 5.8
against 5.0 and neither side produced a presentable set. The per-occasion table and the
weakest occasions are in `eval/results/RESULTS.md`. To rerun it (about 10 minutes and $2):

```sh
node --env-file-if-exists=.env.local eval/run.ts && node eval/report.ts
```

### Where it fails

- **The harness shopper is ours.** Its lines were written by the team and its camera shows a
  test pattern, not a person, so a harness pass says the plumbing works, not that a stranger's
  call will go well.
- **Earlier runs failed.** A run at about 1:45 PM failed on pacing: Alice held the whole bag
  back over one shoe size that was out of stock, and checked in on silence too often. Both
  were fixed later that afternoon. A run on another laptop at 2:00 PM scored 6 of 7; the miss was the check
  itself reading the wrong field, and the bag was correct.
- **Outfit quality is uneven.** 13 of 22 occasions produced a set the judge called
  presentable. Formal occasions are the weak spot.
- **Try-on takes time.** About 20 to 25 seconds from the moment the looks appear (all three
  render at once, so it is usually ready by the pick), and up to 40 when the inspector sends
  one back. The harness shows 31 to 38 seconds because its camera is a test pattern, which
  the inspector correctly rejects as not the shopper.
- **Flat lays.** When a store only publishes photos of a model wearing the piece, the board
  shows a crop of that photo below the chin, not a cut-out.
- **Stock.** A size that is sold out is reported and left out of the cart. Alice does not
  pick the nearest size for you.
- **Buying.** Alice fills the carts and you pay on each store's own checkout page. Placing
  the order inside the call was tried with a real Shop account on the day: the Shop sign-in
  worked and the stores accepted the order request, but Fashion Nova and Steve Madden require
  a step on their own checkout page, so Alice hands over the store link. No in-call order was
  completed, and Everlane and Kith were not tried.
- **Ready-made looks.** For common occasions Alice starts from looks the builder prepared
  earlier in the day, re-checked for price and stock when served. Unusual occasions and
  budgets are built live and take longer.
- **Loud rooms.** Alice can mishear or get cut off; the typed box is the fallback.

## Built today

The repo was created on the morning of November 21, 2026 and everything in it was written
during the event. The ready-made looks in `src/library/sets.json` were generated that
afternoon by this repo's own builder from live store results. The agent and most of the
store page were written with Google Antigravity (Gemini 4 Neon) from briefs the team wrote.

A second session attacked the server and the store client during the event. Its findings
are fixed on `main`: the token endpoint needs a passcode from another machine, occasion
lookups cannot trigger paid calls, logs mask secrets, image downloads are limited to store
CDNs, and renders are capped per call.

## Added after the hackathon: shopper accounts

Not part of what was built or judged on November 21. Off unless `ALICE_ACCOUNTS=on`; with
it off the page, the call token and the agent behave exactly as they did on the day.

With it on, the page gets a Sign in button. A shopper can create an account with an email
address and a password, and Alice then remembers them between calls: their name, men's or
women's, their sizes, and the short notes she makes during a call ("hates wool"). The
account panel shows everything she has kept, with Forget everything, Sign out and Delete
account.

- **What is stored:** the email address, a scrypt hash of the password, hashed session
  tokens and one-call save tickets, and that memory. No photos, addresses or payment details, and no record of the
  conversation, the looks shown or anything bought.
- **Where:** one SQLite file (`ALICE_DB_PATH`, default `data/alice.db`), opened only by the
  web server. On a host that replaces the container on each deploy, it needs a disk that
  survives the deploy.
- **How Alice gets it:** when a signed-in shopper starts a call, the server puts their
  memory in the agent dispatch inside the signed call token, with a one-call ticket for
  that account. During the call the agent sends what it learns to the page (the
  `saveMemory` page action) and the page saves it with the shopper's own session. The
  server accepts a save only when the ticket and the session belong to the same account,
  so one person's call can never write into another person's account. The agent never
  opens the database.
- **Sign in with Shop (`ALICE_ACCOUNTS_SHOP=on`, also off by default):** a second way in.
  The shopper approves on Shop's own page and Shop tells the server who they are in a
  signed ID token; the server keeps Shop's id for them, their email address and first
  name, and discards the access token. It uses Shop's public prototype client. Shop's
  docs say an app that is distributed needs its own registered client, so this is for
  the prototype only.
- **Checks:** `npm test` covers the storage, the routes, the Shop sign-in (against a
  stand-in for Shop, with real signature checks) and the agent side.
  `npm run accounts:check` drives the real page in a browser at desktop and phone width,
  with no model or store calls.
- **Not checked yet:** a real call with accounts on, and a real Shop sign-in.
- **Known gaps:** the address is not verified by email, there is no password reset or
  change, and nothing clears out unused accounts. Off localhost the cookies assume HTTPS.
  The sign-in limits count per visitor address, so they depend on the server seeing each
  visitor's real address (`clientAddress` in `server.ts`); behind a proxy on another
  address every visitor shares one count today, which is safe but lets one person use up
  the sign-in allowance for everyone.

## Where things are

| Folder | What is in it | Owner |
| --- | --- | --- |
| `src/agent/` | The voice agent, its tools and what it tells the page to show | Mike |
| `src/brain/`, `src/library/`, `eval/` | Outfit planning, picking, the critic, the ready-made looks | Jing |
| `src/store/`, `src/media/`, `server.ts` | Store search, carts, try-on and renders, the web server | Soham |
| `public/`, `src/types.ts` | The store page, the call layer, the shared types | Arjun |
| `src/accounts/` | Shopper accounts and what Alice remembers between calls (after the hackathon) | Arjun |
| `scripts/harness/` | A scripted shopper that makes a real call and grades it | Mike |
| `tests/` | Unit tests (`npm test`) | Everyone |
