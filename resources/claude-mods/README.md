# DisTerm token savers

Seven Claude Code mods (function-hook plugins) DisTerm installs as the marketplace
`disterm-token-savers`: `input-router`, `model-router`, `efficient-browser-use`, `handoff`,
`effort-advisor`, `keep-warm` and `research-router`. Each appends
what it saved to `~/.nodeterm/token-savers/savings.jsonl` and obeys the switches in
`~/.nodeterm/token-savers/switches.json`; the contract is `src/shared/token-savers.ts`.

`shared/common.ts` is the source of the helpers they all use. A plugin is installed on its own,
so each carries a copy at `plugins/<mod>/hooks/common.ts`. Edit `shared/common.ts`, then copy it
over every copy: they must stay byte-identical (a DisTerm test checks this).

Each plugin's engine-free logic sits in its own file (`routing.ts`, `policy.ts`, `images.ts`,
`document.ts`, `advice.ts`, `schedule.ts`, `brief.ts`)
and DisTerm's vitest suite loads it (`src/core/token-savers/mod-logic.test.ts`), so `npm test` runs
it too. `claude plugin validate plugins/<mod>` and
`claude plugin test plugins/<mod>` check a mod against the engine.

Files the new mods share with DisTerm, all under `~/.nodeterm/token-savers/`: `handoffs/` (handoff
writes `<node or session>-<epoch ms>.md`; its ledger line's `file` names it), `effort.json`
(effort-advisor's latest suggestion per node, written by the mod) and `keep-warm.json` (the nodes
keep-warm may ping, written by DisTerm and only read by the mod).

Two engine limits shape them. A hook's 10 s budget runs while it awaits a promise of its own, so
research-router waits for its subagent by polling with a short host `sleep` (a `$` call, which the
budget does not count). And a `$.model.fork` that names an `effort` other than the session's can
write the whole chat to a new cache entry instead of reading the main thread's, so keep-warm's
ping names none.
