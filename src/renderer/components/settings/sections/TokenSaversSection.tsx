import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { Button } from '@renderer/ui/Button'
import { TOKEN_SAVER_IDS, TOKEN_SAVER_INFO, TOKEN_SAVERS_MIN_CLAUDE } from '@shared/token-savers'
import { formatTokensShort } from '../../../lib/usageFormat'
import { useTokenSavers, useTokenSaversSnap } from '../../../state/tokenSavers'

const ROWS = {
  install: {
    title: 'Install in Claude Code',
    keywords: ['token', 'savers', 'mods', 'plugin', 'install', 'claude', 'haiku', 'cost', 'cheaper']
  },
  mods: {
    title: 'Mods',
    keywords: ['input router', 'model router', 'subagent', 'browser', 'screenshot', 'switch', 'off']
  },
  savings: { title: 'Savings', keywords: ['savings', 'saved', 'ledger', 'panel', 'cache'] }
}
const ENTRIES = Object.values(ROWS)

/**
 * Settings → Token savers (docs/reference/token-savers.md). Every render path reads an optional
 * snapshot: the section must not throw while the first fetch is in flight, since every section is
 * mounted whenever Settings is open.
 */
export function TokenSaversSection({ isActive }: { isActive: boolean }): React.JSX.Element | null {
  const snap = useTokenSaversSnap()
  const unavailable = useTokenSavers((s) => s.unavailable)
  const busy = useTokenSavers((s) => s.busy)
  const { install, uninstall, setSwitch } = useTokenSavers.getState()

  return (
    <SettingsSection
      id="token-savers"
      title="Token savers"
      description="Claude Code mods that keep big tool results and easy subagent work off your expensive model. They run inside Claude; DisTerm installs them, switches them, and shows what they saved."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.install}>
        <FieldRow
          label="Install in Claude Code"
          description={`Adds the disterm-token-savers marketplace to Claude Code on this machine (every local Claude account) and installs the mods. Needs Claude Code ${TOKEN_SAVERS_MIN_CLAUDE} or newer. Running sessions pick them up after /reload-plugins or a restart. SSH hosts are not covered yet.`}
          note={
            unavailable
              ? 'Not available in this window.'
              : snap?.installError
                ? snap.installError
                : snap?.installed
                  ? 'Installed.'
                  : 'Not installed.'
          }
          control={
            snap?.installed ? (
              <Button disabled={busy || unavailable} onClick={() => void uninstall()}>
                {busy ? 'Working…' : 'Remove'}
              </Button>
            ) : (
              <Button disabled={busy || unavailable || !snap} onClick={() => void install()}>
                {busy ? 'Working…' : 'Install'}
              </Button>
            )
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.mods}>
        <div className="space-y-5">
          {TOKEN_SAVER_IDS.map((id) => {
            const t = snap?.byMod[id]
            return (
              <FieldRow
                key={id}
                label={TOKEN_SAVER_INFO[id].title}
                description={TOKEN_SAVER_INFO[id].what}
                note={t && t.actions > 0 ? `${t.actions} actions, ~${formatTokensShort(t.saved)} tokens kept out` : 'No actions yet.'}
                control={
                  <Switch
                    checked={snap?.switches[id] ?? true}
                    disabled={!snap || unavailable}
                    onChange={(v) => void setSwitch(id, v)}
                    ariaLabel={`${TOKEN_SAVER_INFO[id].title} on`}
                  />
                }
              />
            )
          })}
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.savings}>
        <FieldRow
          label="Savings"
          description="Every action the mods took, across all agents, with the helper model's cost. Each Claude node's context meter also shows its prompt-cache clock and what was saved in that chat."
          control={
            <Button
              disabled={unavailable}
              onClick={() => window.dispatchEvent(new CustomEvent('nodeterm:open-token-savings'))}
            >
              Open
            </Button>
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
