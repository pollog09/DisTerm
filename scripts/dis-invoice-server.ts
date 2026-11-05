// The Server Edition for a run against the fake dis-invoice connector. An ordinary server boot merges
// managed hooks and skills into the real ~/.claude, ~/.codex and the rest, pointed at this data dir,
// so a throwaway run must not be one. Same opt-out every server test takes.
import { resolveConfig } from '../src/server/config'
import { startServer } from '../src/server/index'

void startServer({ ...resolveConfig(process.env, process.argv.slice(2)), installHooks: false }).then(({ port }) => {
  console.log(`proof server on http://127.0.0.1:${port} (managed hooks not installed)`)
})
