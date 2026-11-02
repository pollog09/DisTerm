import { useState } from 'react'
import { useSettings } from '../../../state/settings'
import { useTerminalProfiles } from '../../../terminal/use-terminal-profiles'
import { useCoreIsWindows } from '../../../terminal/use-core-platform'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'

const ROWS = {
  shell: {
    title: 'Default shell',
    keywords: ['shell', 'bash', 'zsh', 'fish', 'default', 'wsl', 'powershell', 'cmd', 'ubuntu']
  }
}
const ENTRIES = Object.values(ROWS)

const CUSTOM = '__custom__'

export function ShellSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const defaultShell = useSettings((s) => s.settings.defaultShell)
  const update = useSettings((s) => s.update)
  const profiles = useTerminalProfiles(useCoreIsWindows() && isActive)
  const [customChosen, setCustomChosen] = useState(false)
  const custom = customChosen || !profiles.some((p) => p.value === defaultShell)
  return (
    <SettingsSection
      id="shell"
      title="Shell"
      description="The shell new terminals launch. Empty uses the system default."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.shell}>
        <FieldRow
          label="Default shell"
          control={
            <div className="flex items-center gap-2">
              {profiles.length > 0 && (
                <Select
                  aria-label="Default shell profile"
                  value={custom ? CUSTOM : defaultShell}
                  onChange={(e) => {
                    const chosen = e.target.value
                    setCustomChosen(chosen === CUSTOM)
                    if (chosen !== CUSTOM) update({ defaultShell: chosen })
                  }}
                >
                  {profiles.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                  <option value={CUSTOM}>Custom…</option>
                </Select>
              )}
              {(profiles.length === 0 || custom) && (
                <Input
                  className="w-64"
                  placeholder="system default"
                  value={defaultShell}
                  onChange={(e) => update({ defaultShell: e.target.value })}
                />
              )}
            </div>
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
