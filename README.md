# Kinlings

Kinlings is a shared valley game. Everyone farms side by side, raises mythical creatures and breeds them with each other's. Then you race them yourself: a live 3D dash where you sprint, jump obstacles and spit fire at the rivals in front. Cross two creatures and you may hatch a species nobody has ever seen, and the first person to hatch it names it for everyone.

Track: **Games With Real Economies** (`games`). Also relevant to `nfts` and `agents`.

The whole game runs in a browser and on one NEAR contract, with no server. Your farm gets its own NEAR account, so everyday moves (planting, feeding, practice races) need no pop-ups and no seed phrase. NEAR is the game's real money: challenge races between players are entered and won in testnet NEAR, champions are hired for it, and stalls sell eggs, Kinlings and rare foods for it. Connect a testnet wallet and every prize, hire fee and sale is paid straight into it.

## The problem

Most people will never make a blockchain account on purpose, because a wallet asks them to care about something they don't yet care about. People do care about pets, gardens and their friends.

In Kinlings, **every creature is a real NEAR account, and its babies are its sub-accounts.** Someone who has never heard of NEAR ends up owning a named account because they hatched a baby dragon. The family tree is the account tree:

```
kinlings.testnet                     the valley
└── flint.kinlings.testnet           a founder Kinling
    └── spark.flint.kinlings.testnet its baby, a species nobody had seen before
```

Both of those are live on testnet right now.

Only an account's direct parent can create its sub-accounts on NEAR, so a baby can only be born from its mother's account. No other chain has this, and the game is built around it.

## Try it (no accounts or installs needed for steps 1 to 3)

Each step says what to do and what you should see. `kinlings.testnet` is the live contract on NEAR testnet.

**1. See a creature that is a real account.**

```bash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"bracken.kinlings.testnet"}}'
```

You should see `"amount":"0"`, `"storage_usage":132` and a `global_contract_hash`. It is an account that holds no NEAR and runs one shared Global Contract.

To see a baby born under its mother, change `bracken.kinlings.testnet` to `spark.flint.kinlings.testnet`. Its account only exists because `flint.kinlings.testnet` created it.

**2. See that it has no keys, so nobody can sign for it.**

```bash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"bracken.kinlings.testnet"}}'
```

You should see `"keys":[]`.

**3. See every item in one NEP-245 contract, and the fixed supply.**

```bash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"kinlings.testnet","method_name":"mt_supply","args_base64":"eyJ0b2tlbl9pZCI6ImFjb3JuIn0="}}' | python -c "import sys,json; print(bytes(json.load(sys.stdin)['result']['result']).decode())"
```

You should see `"10000000"`: there are exactly ten million acorns, forever.

**4. Play it.** The quickest way is the hosted copy at <https://zecozq.github.io/kinlings/>, with nothing to install. To run it yourself you need Node 22 or newer:

```bash
cd web
npm ci
npm run dev
```

Open <http://localhost:3000> (or the hosted copy), type a name and press **Play**. No wallet prompt appears, and your new farm account comes with a little testnet NEAR. Then:

| Do this | See this |
|---|---|
| Tap the egg, pick a name, press Hatch | A unique creature appears. It is now a real account named after it |
| Tap an empty plot and plant Sunwheat | A sprout appears at once. The move settles in the background |
| Wait 40 seconds, tap the sparkling crop | Crops land in your bag |
| Tap your Kinling and feed it five times | It levels up and is grown. A sixth Sunwheat is refused: each food can only raise a Kinling so far, and the 30 levels above need finer food, up to the rare Stardust Honey |
| Open **Market** and hover over a price | The shopkeeper explains, in words, why that is the price |
| Open **Almanac → The economy → Fast-forward a week** | A week of trading plays out in one minute, using the same pricing code the contract runs |
| Open **Pair**, choose an Elder's Kinling, press Pair them | An egg arrives. After it hatches, the baby's account sits under its mother's |
| Open a second private window, press Play, walk over with the arrow buttons and tap the first player's crop | Both players are helped: the crop speeds up and the helper earns acorns |
| Open **Dash** and press **Practice now** | A free race starts at once, against real Kinlings driven by the game. Use the arrow keys or on-screen buttons to change lane and control speed, Space to jump, 1 to 8 for powers. The top three win acorns and crops, and a win sometimes brings home a rare food. Practice never pays NEAR. At the end, a link shows the contract replaying your moves |
| Open **Dash → Challenges for NEAR**, open one for 0.01 NEAR, and run it | Your farm pays the entry fee and your run sets the time to beat. In the second window, join it and run: you race the ghost of the first run. When the seats are full, the fastest is paid every entry fee in NEAR |
| Open **Market → Stalls**, price something in NEAR, and buy it from the other window | The buyer pays in NEAR and the seller is paid 98% of it at once |
| Open **Dash → Hire a champion** and hire one | NEAR leaves your farm account, and the owner is paid into theirs at once. Race it, or pair yours with it |
| Press **Connect wallet** at the top | Connect a testnet NEAR wallet: every prize, hire fee and sale is then paid to it |
| In **My NEAR**, press **Connect NEAR Social** | Link your near.social (mainnet) profile: your name and picture, the people you follow who play, races against their Kinlings, and posts you write yourself |

A 2:19 film of real play is in [docs/kinlings-demo.mp4](docs/kinlings-demo.mp4). It was drawn one frame at a time at 1920x1080, with the game held at full quality.

**5. Run the same game end to end from a terminal.**

```bash
cd web
npm run smoke
```

This opens two farms through the public front door, hatches, trades, checks that food stops helping at its level, pairs across players, checks that a baby's account exists under its mother's, runs a challenge race between the two players for NEAR (both runs driven move by move and replayed by the contract, and the winner paid both fees), hires a Kinling for NEAR, sells on a NEAR-priced stall, and drives a free practice race. It prints each check and spends a little testnet NEAR.

**6. Run the tests.**

```bash
cargo test --release -p kinlings-core --features sim
cargo test -p kinlings-valley
```

You should see 72 rules tests and 67 whole-flow contract tests pass. The rules tests include a week-long simulation that checks not one acorn is created or lost at any step, a tournament showing no fixed farming strategy beats all the others, and 150 raced courses replayed move by move to prove the replay always matches.

On Windows the contract tests need `AWS_LC_SYS_PREBUILT_NASM=1` and `AWS_LC_SYS_CMAKE_BUILDER=0` set, because a test-only dependency wants an assembler.

## How the game plays

The design was written on paper before any code, in [GAME_LOOP.md](GAME_LOOP.md). In short:

- **Every 30 seconds:** plant, water, harvest, feed, help a neighbour.
- **Whenever you like:** race. Practice is free against the valley's Kinlings, for acorns and crops. Challenges are against real players, for testnet NEAR. There's no timer and no replay to sit through. You steer, sprint, jump and use your Kinling's powers, and a race takes about 45 seconds.
- **Every 5 minutes:** decide what to plant given prices other people moved, sell, hatch an egg, pick a partner.
- **Every session:** discover and name species, breed a stronger generation, hire out your champions, build a bloodline that earns while you're away.

### Food and levels

A Kinling has 30 levels, and every level makes it a little faster in a race. Each food can only raise it so far: Sunwheat to level 3, Dewbean to 5, Emberroot to 8, Frostberry to 11, Moonmelon to 14 and Starfig to 16. Racing helps up to level 8. Past 16 it needs the rare foods, which no shop sells: **Glowcap** (to level 20) turns up in about one in twelve Frostberry or Moonmelon harvests, **Dragonfruit** (to 25) in Starfig harvests and a quarter of rested race wins, and **Stardust Honey** (to 30) in about one Starfig harvest in a hundred. So the finest Kinlings are fed by the players who trade for them, at stalls priced in acorns or NEAR. Served at a pairing, a rare food is more likely to wake a power, and Stardust Honey always wakes a new one.

### Powers and generations

There are eight race powers: Fire Spit, Frost Breath, Storm Bolt, Wind Dash, Bubble Shield, Vine Snare, Blink Step and Second Wind. A founder is born with one or two. **A baby keeps every power both parents have**, and what you serve at the pairing can wake a new one. **Every baby is stronger than its stronger parent**, and powers hit harder and recharge sooner with each generation. There is no ceiling on stats, no limit on eggs and no limit on how many Kinlings you can own.

## The economy

- **Ten million acorns, fixed forever.** They sit in pockets, shop tills, Kinlings' purses or the Old Oak, the town treasury. Nothing is printed or destroyed.
- **Four shopkeepers with their own accounts and stock** ([`bramble.kinlings.testnet`](https://testnet.nearblocks.io/address/bramble.kinlings.testnet) and others) set prices from stock and recent demand. Their rules live in one readable file: [`crates/core/src/pricing.rs`](crates/core/src/pricing.rs). The contract runs it on chain, and the browser compiles the same file to explain each price in a tooltip.
- **Flood a market and prices fall.** A shop that runs out of money closes until a player backs it, and backers then earn a slice of its sales.
- **Player-owned stalls** sell crops, rare foods, eggs and Kinlings at prices players choose, in acorns or in testnet NEAR. A NEAR sale pays the seller 98% at once, to their wallet.
- **Bloodlines pay.** When a Kinling earns, a slice climbs to its parents and grandparents.
- **Real testnet NEAR moves between players.** A challenge race is opened with an entry fee, from 0.01 to 1 NEAR, and two to six players join by paying the same. Everyone runs the same course against the same field, once, within the hour, and the fastest share every fee: all of it with two runners, 70/30 with three, 60/30/10 with four, 50/30/20 with five or six. The valley keeps none. Anyone can also offer a Kinling for hire: 85% of the fee goes straight to the owner, 3% to each parent's owner and the rest to the valley's fund. A champion is worth hiring because a baby takes on its powers and beats its stats. Free practice races never pay NEAR.
- **Species are found, not shipped.** Fifteen of the 750 kinds have names at launch. A finder names the rest and earns a small fee on every later hatch.
- **It changes without a patch.** When the Oak runs low its gifts shrink. Shops catch up on the time that has passed whenever someone next visits, so no server has to run.

## What NEAR does here

| NEAR feature | Its job in the game | Where |
|---|---|---|
| Named sub-accounts | The family tree is the account tree. A baby can only be created by its mother's account | [`crates/kin/src/lib.rs`](crates/kin/src/lib.rs) |
| Global Contracts (NEP-591) | Every creature runs one 1.7 KB contract by hash, so a creature stores no code | [`crates/kin/src/lib.rs`](crates/kin/src/lib.rs) |
| Zero-balance accounts | A creature account is small enough to hold no NEAR at all | `bracken.kinlings.testnet` |
| NEP-245 | One contract holds acorns, crops, tonics, eggs and Kinlings | [`crates/valley/src/ledger.rs`](crates/valley/src/ledger.rs) |
| Function-call keys | A key in the browser can only call the game, so moves are signed silently | [`web/src/game.ts`](web/src/game.ts) |
| Cheap computation on chain | When a race ends, the contract replays all six racers over every tick from the player's move list, in about 15 Tgas, and pays only what it saw | [`crates/core/src/dash.rs`](crates/core/src/dash.rs), [`crates/valley/src/races.rs`](crates/valley/src/races.rs) |
| An account that runs a contract | A farm account runs the same 1.7 KB contract, so its no-transfer key can still pay for a hire: the valley asks the account to send NEAR, and the account only obeys the valley | [`crates/valley/src/rentals.rs`](crates/valley/src/rentals.rs) |
| Attached NEAR from any wallet | `rent_kin`, `open_challenge`, `join_challenge` and `buy_listing_near` take a deposit from a wallet connected through NEAR Connect, for a farm that may not be the wallet | [`web/src/wallet.ts`](web/src/wallet.ts), [`crates/valley/src/challenges.rs`](crates/valley/src/challenges.rs), [`crates/valley/src/market.rs`](crates/valley/src/market.rs) |
| NEAR Social (FastData KV, mainnet) | A player links their near.social profile to their farm from both sides: the farm names the profile on the valley, and the profile names the farm in `profile/links/kinlings`. The game reads who they follow to find friends who play, and posts only what the player writes and approves | [`web/src/social.ts`](web/src/social.ts) |
| Promises across blocks | Hatches are rolled in a later receipt, so a caller can't see a bad roll coming or undo it | [`crates/valley/src/hatch.rs`](crates/valley/src/hatch.rs) |
| NEAR Auth (optional) | Google or email sign-in, with the login's MPC-held key owning the account | [`web/src/auth.ts`](web/src/auth.ts) |

The Kinling contract's hash is `b84fca8d0485e2bf991a4f0565096238629ce0f5acb7d5df47626cba4d3d5e4f`, and the valley's deployed build has SHA-256 `2a9329c697d48b1541263cf0ec18ba9074feb6f665bab57faea54d655ce8cd92`.

## How it is built

```
crates/core      The rules, with no blockchain code: prices, genetics, the race engine, the simulator
crates/valley    The contract: NEP-245 ledger, farms, shops, stalls, breeding, races, NEAR hires
crates/kin       The tiny Global Contract each creature account runs
crates/browser   The same rules compiled to WebAssembly for tooltips, fast-forward and the live race
web              The game: 3D valley and race in Three.js, all art and music generated by code, no server
tools/music      Composes and renders the soundtrack from code
```

- **No server.** A new player signs one transaction with the valley's front-door key, which NEAR restricts to `open_account`. The contract caps openings at 60 an hour. The key is in [`web/src/chain.ts`](web/src/chain.ts) on purpose: every visitor's browser needs it, and it can't move NEAR or touch a farm, so it is public by design rather than a leaked secret.
- **Moves are batched.** Taps change the screen immediately and go to the contract together, as one small `act` call that costs about 3 Tgas. A stale tap fails alone and the others still count.
- **A race is one engine in two places.** The browser runs `dash.rs` live at 30 ticks a second, and the contract runs the same file over the recorded moves. All of it is whole-number arithmetic, so the two can't drift apart.

## Honest limits

- It runs on testnet. Moving to mainnet is a deployment, not a redesign, but each new account costs about 0.007 NEAR, so hatching would need a real fee.
- Google or email sign-in uses NEAR Auth's shared testnet client, which only accepts `http://localhost:3000`, and it has **not been tested with a real login yet**. A hosted copy needs its own client id in `VITE_KINLINGS_AUTH_CLIENT`. Guest play works everywhere.
- A guest's key lives in that browser, so clearing site data loses the farm. A sign-in on a second device starts a new farm rather than finding the old one.
- NEAR Intents is not used. It has no testnet, and I chose not to bolt on a read-only quote just to tick a box. Since every Kinling is a real account, a mainnet version could receive assets from any chain.
- Contract state is public, so anyone can read a hatched creature's genes. Eggs have no genes until the moment they hatch, so an egg's contents can't be read early.
- Farms marked ELDER are computer-run scenery with real creatures, kept so races always have a field. Their crops are decoration on a timer, not real produce. The "online" count comes only from real activity, plus you.
- In a practice race, your rivals are real Kinlings owned by real players, and their owners are paid acorns when they place, but the game drives them, not their owners.
- Challenge races are real players against each other, but not at the same moment: everyone runs the same course and field once, whenever they like within the hour, and later runners race the ghosts of earlier runs. Racing live side by side would need a server. Later runners also know the time to beat.
- The contract proves a race followed the rules, not that a person was at the controls. A bot can submit a very good race. Prizes are small, boosted races are rationed per Kinling, and the Oak's boost and the NEAR pot both shrink as they empty, so farming them doesn't pay much.
- The "Pay with a wallet" paths have been tested by paying from another testnet account on the command line. They have **not been run through a real wallet's approval popup**, because that needs a person.
- NEAR Social reading is tested against the live near.social API. Writing (linking a profile, posting) needs a person's own mainnet account and wallet, so it has **not been run yet**. Following the near.social guide, the wallet may report each write as failed, because `social` has no contract. The game reads the result back from near.social instead of trusting that report.
- Rare finds use the block's random seed. That's fine on testnet. On mainnet, validators could bias it a little.
- The browser key on a farm account can spend that account's NEAR on hires and send it to a wallet you choose. That's fine for test NEAR. A mainnet version should cap it or ask the login key.
- The farms named Maya, Theo and Ava were created by the automated film session. The film is real play on the live contract, by scripted browser sessions. The Glowcap sold in it was grown for real off camera: 30 practice races brought home no rare food, so the film farm grew Frostberry until two harvests turned one up.
- The owner account can add Elders and can upgrade the contract while the game is on testnet.

## Credits and disclosure

- **Built with:** Rust, near-sdk 5.30, near-sys, cargo-near, TypeScript, Vite, Three.js, @noble/ed25519. NEAR Connect loads only if someone connects a wallet, and NEAR Auth's browser SDK and near-api-js only if someone signs in.
- **AI use:** designed and written with Claude Code. All art, music and sound are generated by code in this repository.
- **The demo film:** the voice is AI-generated with Orpheus, an open speech model, and the score is generated by code in this repository (`tools/music/compose.py`, laid out to fit the cut). It is real play on the live contract by scripted browser sessions. Every shot is drawn one frame at a time at 1920x1080 on the page's own clock, with the game held at full quality (`?quality=high&film=1` stops it trading resolution for frame rate), and no shot is cropped or zoomed in the edit. Some menu, typing and naming shots are sped up a little (at most 1.7x), and the sunrise and dusk are the game's own sky moved along by script. The two challenge runs play at real speed: they are real races on the live contract, each handed in and checked by it, and their sound effects were added in the edit.
- **Mythical creatures** are public-domain folklore. The creature art, world and characters are original to this project.
- **Built during NEAR HACKATHON:** every line in this repository was written during the hackathon, starting on 2026-11-09. There is no earlier code.
- **Licence:** MIT, in [LICENSE](LICENSE).
