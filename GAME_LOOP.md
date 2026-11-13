# Kinlings: the game on paper

Written before any code, as the track brief asks. If the build and this page disagree, the page is wrong and gets updated.

## The game in one breath

Kinlings is one shared valley. Everyone farms side by side, raises mythical creatures (Kinlings) and breeds them with each other's. Then you race them yourself: sprint, jump obstacles and spit fire at whoever is in front. Cross two creatures and you may hatch something nobody has ever seen. The first person to hatch it names it, for everyone, forever.

A player signs in, gets an egg, and taps it. Their farm has its own NEAR account with a key that can only play this game, so everyday moves need no pop-ups, seed phrase or gas. NEAR is the game's real money: players race each other for testnet NEAR, hire champions with it, and sell eggs, Kinlings and rare foods for it. A connected testnet wallet collects every prize, fee and sale.

## Who it is for

Anyone who has enjoyed a pet, a garden, or watching a race. A seven-year-old can play the first minute. A market nerd can spend a week on crop prices and bloodlines.

## The three loops

### Every 30 seconds: tend

| The player does | They get |
|---|---|
| Taps a plot to plant, water or harvest | A crop, a pop of sound, acorns ticking up |
| Feeds a Kinling | It grows, and what it eats nudges what its babies can be. Each food only raises a Kinling so far, so the high levels need rare food |
| Walks next door and waters a neighbour's crop or warms their egg | Both players gain: the neighbour's timer drops, the helper gets acorns |
| Waves at whoever is around | A little bubble over the neighbour's farm |

Every tap responds instantly. The game settles taps in small batches behind the scenes.

### Every 5 minutes: decide

| Moment | The decision |
|---|---|
| A batch of crops ripens | What to plant next. Prices moved because of what everyone else planted. Moonmelon is high now, so everyone will plant it, so will it still be high when yours ripens? |
| Selling | A shopkeeper at today's price, or your own stall at a price you pick? |
| An egg is ready | Hatch it, or sell it unhatched on its pedigree alone? Nobody knows what is inside, including the seller |
| A Kinling is grown | Who to pair it with, and which food to serve first. Hire a champion for NEAR, and your baby takes on its powers |

### Whenever you like: race

The Valley Dash starts the moment you ask. There is no timer to wait for and no replay to watch. You drive. There are two ways to race:

- **Practice**, free and any time, against the valley's Kinlings. The top three win acorns and crops, and a rested winner sometimes brings home a rare food. Practice never pays NEAR. It is where you learn the course and the powers.
- **Challenges**, against real players for testnet NEAR. Someone opens one with an entry fee and a number of seats, and others join by paying the same. Everyone runs the same course against the same field, once, whenever they like within the hour, racing the ghosts of whoever ran before them. The fastest times share every entry fee, paid straight to their wallets.

| The player does | What happens |
|---|---|
| Changes lane | Dodges rocks and hedges, or lines up a pickup |
| Holds Sprint, or eases off | Runs faster and burns breath, or slows down and gets it back. Run out and you're winded |
| Jumps | Clears logs, hedges and fireballs. Mud is slow unless you hop it |
| Uses a power | Spit fire at the racer ahead, freeze the pack, call lightning, dash, shield up, drop a snare, blink forward, get your breath back |

In practice, the five rivals are real Kinlings owned by other players. If one of them places, its owner is paid acorns while they're away. New players' rivals start clumsy and sharpen up over their first nine races. Link NEAR Social and you can ask for the Kinlings of people you follow first.

When the race ends, the browser sends only the list of moves. The contract plays all six racers again from those moves and pays only what it saw.

### Every session: build a family

- **Hatch something new.** There are 750 possible creature types and only 15 have names at launch. A new one gets a valley-wide banner, the finder names it, and earns a small fee every time anyone hatches another.
- **Grow the family, without limit.** There's no cap on eggs, children or Kinlings. Every baby keeps all its parents' powers and comes out stronger than the stronger parent, and each generation's powers hit harder and recharge sooner. When a Kinling earns, a slice climbs its family tree to its parents and grandparents, so a good bloodline pays while you are away. "While you were gone, your family earned 46 acorns."
- **Earn real NEAR.** Win challenge races. Offer a strong Kinling for hire at a price you set: whoever hires it pays testnet NEAR, and most of it lands straight in your wallet. Sell what others can't easily get, such as eggs from a famous line or a jar of Stardust Honey, for NEAR at your stall.
- **Feed it further.** A Kinling has 30 levels. Crops take it to level 16 at most, each only so far: Sunwheat to 3, up to Starfig at 16. Racing helps to level 8. Past that, it needs Glowcap, Dragonfruit and Stardust Honey, which no shop sells. They turn up at the best harvests and at race wins, rarely, so most players trade for them.
- **Spend it.** More land, faster incubation, a stronger line.
- **Level up** through farmer ranks. Higher ranks unlock better crops.

## Why it does not go stale

No decision has a permanently right answer.

- Crop prices chase what players planted last, so the obvious crop is often the wrong crop.
- Rare traits are recessive. Two plain parents can carry something extraordinary, and a plain-looking Kinling can be a bargain.
- A Kinling can race whenever you like, but the Old Oak only puts up a prize for a rested one, and a hired champion costs real NEAR by the half hour.
- Rare food is scarce by design, so its price is whatever players will pay. Feeding your champion Stardust Honey or selling it to someone else is a real choice.
- Growing one crop again and again raises its yield, but the market punishes everyone who does the same.
- A race is won with timing. A strong Kinling that keeps crashing loses to a weaker one driven well.

The balance test in `crates/core` plays thousands of simulated weeks with fixed strategies (always plant the priciest, always the cheapest, never sell, and so on). It fails the build if one fixed strategy dominates.

## How people play together

Real players only. The "online" count comes from real recent activity, and any computer-run character carries an **Elder** badge.

1. **Neighbours.** Your farm sits beside other people's on one long valley road. Walk over and help.
2. **Breeding needs another creature.** Anyone can list a Kinling on the Matchmaker board for a fee they choose.
3. **Races.** Challenge your friends for NEAR, or practise against other people's real Kinlings, which earn acorns for their owners when they place.
4. **Hire.** Pay another player in NEAR to race or breed with their champion for half an hour.
5. **Stalls.** Sell crops, rare foods, eggs and Kinlings to other players at your own price, in acorns or NEAR.
6. **NEAR Social.** Link your near.social profile to find the people you follow who play, race their Kinlings, and post your wins in your own words.
7. **Gift an egg by link.** The friend opens the link, plays immediately, and finds an egg from you.

## The economy

There are exactly **10,000,000 acorns**, forever. Every acorn is in someone's pocket, a shop's till, a Kinling's purse, or the **Old Oak**, the town treasury. Nothing is printed and nothing vanishes. A test checks this after every simulated action.

```
                 welcome gifts, helping bonuses, race top-ups
        ┌───────────────────────────────────────────────────────┐
        │                                                       ▼
   THE OLD OAK ──villagers buy food──▶ SHOPS ◀──buy & sell──▶ PLAYERS
        ▲                                ▲                      │  ▲
        │                                └── investors ─────────┘  │
        │                                                          │
        └── breeding fees, land, market tax ──── PLAYERS ──────────┘
                                                    │ prizes, stud fees
                                                    ▼
                                           KINLING PURSES ──▶ up the family tree
```

- **When the Oak runs low, its gifts shrink automatically.** The economy steadies itself without a patch.
- **Four shopkeepers** have their own wallets and stock: Bramble (staple crops), Cinder (spice crops), Moth (moon crops) and Nana Wick (tonics and wild eggs).
- **Each one sets prices from its stock and recent demand** using one readable file, `crates/core/src/pricing.rs`. Hover any price to see the shopkeeper's reasoning, in plain words.
- **Flood the market and prices fall.** If everyone sells Sunwheat, Sunwheat gets cheap.
- **A shop that runs out of money closes** until a player invests. Investors earn a share of its profits afterwards.
- **What changes without a dev patch:** crop prices, which shops survive, which species exist and what they are called, which bloodlines are valuable, how generous the Oak can be.

## Fast-forward

One button simulates a week of trading in a minute, using the same Rust pricing file the contract runs, compiled for the browser. It starts from the valley's live numbers. You can watch prices cycle, shops go broke and reopen, and families rise. It is clearly labelled as a simulation and touches nothing real.

## The twist only NEAR makes possible

Every Kinling **is a real NEAR account**, and its babies are its **sub-accounts**:

```
kinlings.testnet                     the valley
└── flint.kinlings.testnet           a founder Kinling
    └── spark.flint.kinlings.testnet its baby
```

- **The family tree is the account tree.** Anyone can read a bloodline from the name, with no indexer or database.
- **Your pet is a working wallet.** Anyone can send it money by name, and its owner can collect.
- **A family line never runs out.** NEAR account names stop at 64 characters, so a very long line starts a new branch under the valley, and the family tree carries on.
- **Each creature runs one shared, tiny Global Contract** (NEP-591) and holds no access keys, so nobody can sign for it. It only obeys the valley's rules.

Other NEAR features doing real work:

| Feature | Job |
|---|---|
| NEP-245 | One contract holds every item: acorns, crops, tonics, eggs, Kinlings, shop shares |
| Function-call keys | A limited key in the browser plays without popups |
| Social login (NEAR Auth) | Google or email sign-in, with no seed phrase |
| Zero-balance accounts | A Kinling account is small enough to exist holding no NEAR at all, so a family can grow cheaply |
| Later-block randomness | Hatches settle in a separate receipt, so nobody can peek or undo a bad roll |
| On-chain replay | The contract re-runs a whole race from the player's moves, for about 15 Tgas |
| Attached NEAR and transfers | Challenge fees, hires and stall sales are paid in testnet NEAR, and winners and sellers are paid straight into their wallets |
| NEAR Social | A near.social profile and a farm name each other, so a link can't be faked. Friends are found from who a player follows |

## Why this helps NEAR and its users

1. **A friendly first account.** Someone who has never heard of NEAR ends up owning a named account they care about, and a pet is a better reason to keep one than a seed phrase.
2. **Every gifted egg and every breeding partner brings someone new in.**
3. **Open building blocks.** The NEP-245 ledger, the sub-account family pattern and the no-popup login are reusable by anyone building on NEAR.

## Honest limits

- Runs on testnet. NEAR Intents has no testnet, so anything using it is a read-only quote.
- Contract state is public, so anyone technical can read a creature's genes after it hatches. Eggs are decided only at hatching, so nobody can read an egg's contents early.
- Google or email login needs NEAR Auth's approved client id on a hosted site. Guest play works everywhere.
