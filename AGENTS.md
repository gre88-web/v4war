# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single product, **Siege of the Crown** (Phase 1): a Solidity smart
contract (Foundry) plus a Vite/TypeScript + ethers.js canvas frontend. There is
no traditional backend or database — all game state lives on-chain.

### Services / components

| Component | How to run (dev) | Notes |
| --- | --- | --- |
| Contract toolchain | `forge build`, `forge test` | Foundry. No external Solidity deps/submodules; tests are self-contained. |
| Local chain | `anvil --host 0.0.0.0` | Local EVM at `http://127.0.0.1:8545`, chainId `31337`. |
| Frontend | `npm run dev` | Vite dev server on port `5173` (`--host 0.0.0.0`). |

Standard commands live in `README.md` and `package.json` scripts; don't duplicate
them. The frontend has no ESLint config — the type-check via `tsc` (part of
`npm run build`) is the lint gate.

### Non-obvious setup/run caveats

- Foundry (`forge`/`anvil`/`cast`) installs to `~/.foundry/bin`, which is added to
  `PATH` via `~/.bashrc`. Login shells pick it up automatically; if a
  non-interactive shell can't find `forge`, call it as `~/.foundry/bin/forge`.
- `forge fmt --check` reports diffs against the committed source (pre-existing
  formatting). It is not wired into CI; do not treat it as a required gate and do
  not reformat existing files just to satisfy it.
- The frontend needs a `.env.local` (gitignored). To run fully end-to-end against
  a local chain, deploy the contract to anvil and point the env at it:
  - `VITE_CONTRACT_ADDRESS=<deployed address>`
  - `VITE_CHAIN_ID=31337`, `VITE_CHAIN_NAME=Anvil`
  - `VITE_RPC_URL=http://127.0.0.1:8545`
  Without `VITE_CONTRACT_ADDRESS` the UI only shows "Configure VITE_CONTRACT_ADDRESS to read the game."
- Deploy locally with the script using an anvil dev key, e.g.:
  `PRIVATE_KEY=<anvil key 0> TREASURY=<anvil addr 0> forge script script/DeploySiegeOfTheCrown.s.sol --rpc-url http://127.0.0.1:8545 --broadcast`
  Only `TREASURY` is mandatory; all other constructor params have defaults.
- The UI is read-only without a wallet (injected EIP-1193 / MetaMask). To exercise
  write actions (`push`/`claim`) without a browser wallet, send transactions with
  `cast send`. `push(faction)` requires `msg.value` to exactly equal
  `costForTiles(faction, tiles)` (or `quote(...)`), otherwise it reverts with
  `INEXACT_PAYMENT`. Faction `0` = Dwarves (push front up), `1` = Orcs (push front down).
- The frontend reflects on-chain changes automatically: it polls `gameState()`
  every 4s and also subscribes to `Pushed`/`Resolved` events.
