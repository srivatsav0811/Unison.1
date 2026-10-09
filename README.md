# Unison IPL Auction

A live, multiplayer IPL-style player auction you run with friends: **1 auctioneer + 5 teams**, a shared room code, 20-second lots, retentions and player exchanges. No build step and no dependencies, only Node 18+.

```bash
npm start            # http://localhost:3000   (PORT=8080 npm start to change it)
npm test             # plays a full auction end-to-end against the server
```

Everyone opens the same URL. Host it on any machine that can run Node; it is not a static site, because the server holds the live auction state.

## How a game runs

1. **Lobby** – someone creates a room and shares the 5-letter code (or the invite link). Up to 6 people join. One picks **Auctioneer**; the other five pick **Team**, name their franchise and choose a unique colour, then **Lock in**.
   The auctioneer sets the **budget (₹50–200 Cr, identical for every team)** and starts the **2:00 countdown**. If all teams have locked in, the auctioneer can **skip the timer**; otherwise the lobby closes when it hits zero (needs at least 2 teams).
2. **Retention** – each team may retain up to 3 players before the auction, at slab prices of 15 % / 11 % / 8 % of the budget. Retained players leave the pool (first team to retain a player gets them). The auctioneer then starts the auction.
3. **Auction** – the auctioneer searches/filters the pool, picks a player, sets the **base price** and puts them on the block. Teams hit **BID** (or press Space). IPL-style increments: +5 L below ₹1 Cr, +10 L to ₹2 Cr, +20 L to ₹5 Cr, +25 L above.
   - **20-second clock** per player; a bid in the final seconds tops the clock back up to 10 s.
   - Clock ends with a bid → **SOLD!** (big red). No bid → **UNSOLD** (big blue). Unsold players can be re-listed.
   - The auctioneer can also **declare the sale** to any team, or mark the player unsold, at any time.
   - **Out of money?** The server refuses any bid a team can't afford, and a team with less than ₹20 L left is flagged and locked out of bidding altogether.
4. **Exchanges** – between lots, teams can offer each other player-for-player swaps with optional cash either way. The other team accepts or rejects; the server re-checks purses and the 25-player squad cap before executing.
5. **Results** – the auctioneer ends the auction; squads are ranked by the combined rating of their best 11.

## Player database

`data/players.js` holds **~450 players** (batters, bowlers, all-rounders, wicketkeepers; India plus Australia, England, South Africa, New Zealand, West Indies, Sri Lanka, Pakistan, Afghanistan, Bangladesh, Ireland, Nepal and the Netherlands), every one of whom has played at least one IPL match. The list and the 40–98 star ratings were compiled from memory, **not** from an official feed, so it is not exhaustive (the IPL has used well over a thousand players) and ratings are subjective. The auctioneer can add missing players in-game (**Pick player → + Add a missing player**), and you can extend the file: one `Name|BAT|IND|75` line per player.

## Notes

- Rooms live in server memory; restarting the server ends all auctions. Refreshing a browser rejoins automatically.
- Rule constants (squad cap, timers, retention slabs, …) are at the top of `server.js`. Test-only env vars: `UNISON_LOT_SECONDS`, `UNISON_LOBBY_SECONDS`, `UNISON_RESULT_MS`.
