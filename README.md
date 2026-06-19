# Siege of the Crown

An on-chain, two-faction FOMO war game on Ethereum. Dwarves and Orcs spend ETH
to move a single shared frontline across 10,000 tiles. The chain stores one
integer (`front`); the frontend renders the pixel battlefield deterministically
from that value.

This repository implements **Phase 1** from the build brief:

- Foundry contract with pull-only pro-rata payouts.
- Full Foundry test suite for pricing, win conditions, timer behavior, bonuses,
  payouts, reentrancy, and edge cases.
- Vite/ethers/Phaser frontend that reads `gameState()` and contract events, then
  submits exact quoted `push()` and `claim()` transactions.

Phase 2 (Uniswap v4 hook/token flywheel) is intentionally not included in this
Phase 1 implementation.

## Mechanics summary

- `front` is in `[0, 10000]` and starts at `5000`.
- Dwarves control `[0, front)` and push `front` upward toward the Orc keep.
- Orcs control `(front, 10000]` and push `front` downward toward the Dwarf keep.
- `front >= 10000` is a Dwarf sudden-death win.
- `front <= 0` is an Orc sudden-death win.
- If the curse timer expires, anyone can call `resolve()` and the tile leader
  wins: Dwarves when `front >= 5000`, otherwise Orcs.
- Winners claim with pull payments. Losers get no payout.

The client-side jagged hex frontline, Phaser sprites/counters, particles,
castle art, goal rings, screen shake, and operational hex-map terrain are
cosmetic. Ownership is derived from `front`.

## Economic constants

Defaults are constructor arguments and are exposed as public immutables.

| Constant | Default | Meaning |
| --- | ---: | --- |
| `TOTAL_TILES` | `10000` | Field size |
| `START` | `5000` | Initial front and required midline |
| `BASE_COST` | `0.0005 ETH` | Price of a midline tile |
| `ESCALATION` | `9` | Keep-adjacent tiles cost about 10x midline |
| `FEE_BPS` | `300` | 3% treasury fee |
| `BONUS_BPS` | `1000` | 10% of net spend goes to bonus pool |
| `BONUS_THRESHOLD` | `7000 / 3000` | 70% tile control threshold |
| `INITIAL_CLOCK` | `24h` | Starting curse timer |
| `EXTEND` | `30s` | Added per push |
| `MAX_CLOCK` | `6h` | Maximum remaining clock after a push |

The timer update follows the brief exactly:

```solidity
deadline = min(deadline + EXTEND, block.timestamp + MAX_CLOCK);
```

With the suggested defaults, the first push during the initial 24h window caps
the remaining clock to 6h.

## Pricing and exact payments

Tile prices are position based:

```text
Dwarf depth at x = max(0, x - 5000)
Orc depth at x = max(0, 5000 - x)
pricePerTile(x) = BASE_COST * (1 + ESCALATION * depth / 5000)
```

The contract computes the arithmetic-series cost for consecutive tiles without
looping over 10,000 tiles. `quote(faction, valueWei)` returns the largest tile
count affordable and the exact cost for those tiles. `push(faction)` requires
`msg.value == quote(faction, msg.value).cost`, so no ETH is pushed/refunded from
`push()` and all payments remain pull/accounting based.

Money flow for each exact payment:

1. `fee = msg.value * FEE_BPS / 10000` accrues to `treasuryCredit`.
2. `bonusCut = (msg.value - fee) * BONUS_BPS / 10000` accrues to `bonusPool`.
3. Remainder accrues to `jackpot`.
4. Player contribution is tracked as `msg.value - fee` for the pushed faction.

## Bonus and payouts

- Sudden-death winners receive jackpot plus the entire bonus pool.
- Timer winners receive the bonus pool only if they control at least 70%:
  - Dwarves: `front >= 7000`
  - Orcs: `front <= 3000`
- If a timer winner does not hit 70%, `bonusPool` rolls into the next round.
- `claim()` pays the current resolved round.
- `claimRound(roundId)` lets winners claim older rounds after a new round starts.
- Claims use checks-effects-interactions and a reentrancy guard.

## Contract commands

Install Foundry if needed:

```sh
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Run tests:

```sh
forge test
```

Deploy:

```sh
export TREASURY=0xYourTreasury
export PRIVATE_KEY=0xYourPrivateKey
forge script script/DeploySiegeOfTheCrown.s.sol \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --verify
```

Optional deploy tunables:

```sh
export TOTAL_TILES=10000
export START=5000
export BASE_COST=500000000000000
export ESCALATION=9
export FEE_BPS=300
export BONUS_BPS=1000
export INITIAL_CLOCK=86400
export EXTEND=30
export MAX_CLOCK=21600
```

## Frontend commands

```sh
npm install
cp .env.example .env.local # or create the variables below manually
npm run dev
```

Required/optional frontend variables:

```sh
VITE_CONTRACT_ADDRESS=0xDeployedGame
VITE_CHAIN_ID=11155111
VITE_CHAIN_NAME=Sepolia
VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
VITE_GEOBLOCKED_TIMEZONES=
```

The app also supports an owner-provided geoblock hook:

```html
<script>
  window.__SIEGE_GEOBLOCK__ = async () => {
    return { blocked: false };
  };
</script>
```

If the hook returns `{ blocked: true, reason: "..." }`, transaction buttons are
disabled and the reason is shown in the HUD.

## Safety note

This is a pooled-stakes PvP money game and is gambling-adjacent. The strategy,
faction, and timing layer may support a game-of-skill framing, but a launching
party must obtain legal counsel and geofence/restrict access for its
jurisdictions. The contract includes an owner-controlled pause, and the frontend
includes a configurable geoblock hook. This repository is not legal advice.

Confirm the economic constants and win/bonus rules again before any mainnet
deployment.
