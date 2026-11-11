# DisTerm token savers

Three Claude Code mods (function-hook plugins) DisTerm installs as the marketplace
`disterm-token-savers`: `input-router`, `model-router` and `efficient-browser-use`. Each appends
what it saved to `~/.nodeterm/token-savers/savings.jsonl` and obeys the switches in
`~/.nodeterm/token-savers/switches.json`; the contract is `src/shared/token-savers.ts`.

`shared/common.ts` is the source of the helpers all three use. A plugin is installed on its own,
so each carries a copy at `plugins/<mod>/hooks/common.ts`. Edit `shared/common.ts`, then copy it
over the three copies: they must stay byte-identical (a DisTerm test checks this).

Each plugin's engine-free logic sits in its own file (`routing.ts`, `policy.ts`, `images.ts`)
and DisTerm's vitest suite loads it (`src/core/token-savers/mod-logic.test.ts`), so `npm test` runs
it too. `claude plugin validate plugins/<mod>` and
`claude plugin test plugins/<mod>` check a mod against the engine.
