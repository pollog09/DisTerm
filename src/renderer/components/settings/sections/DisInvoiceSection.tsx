import { useEffect, useState } from 'react'
import type { DisInvoiceStatus } from '@shared/dis-invoice'
import { DIS_INVOICE_KEY_CHANGED } from '@renderer/state/disInvoiceSyncRun'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'

const ROWS = {
  key: {
    title: 'Connector key',
    keywords: ['dis-invoice', 'connector', 'key', 'sync', 'tasks', 'kanban', 'board', 'client']
  }
}
const ENTRIES = Object.values(ROWS)

const STORAGE_NOTE: Record<DisInvoiceStatus['storage'], string> = {
  encrypted: 'Stored encrypted on this machine.',
  'restricted-file': 'Stored in a file only your user can read, on the machine running DisTerm.',
  unavailable: 'This machine has nowhere safe to store a key.'
}

/** Save, clear and status only: there is no way to read a key back, so none can leak from here. */
export function DisInvoiceSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const api = window.nodeTerminal.disInvoice
  const [status, setStatus] = useState<DisInvoiceStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    api
      .status()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {
        if (!cancelled) setStatus({ hasKey: false, storage: 'unavailable' })
      })
    return () => {
      cancelled = true
    }
  }, [api, isActive])

  const save = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await api.saveConfig(key)
      if (result.ok) {
        setKey('')
        setStatus(await api.status())
        window.dispatchEvent(new Event(DIS_INVOICE_KEY_CHANGED))
        setNotice({ tone: 'ok', text: 'dis-invoice accepted the key. Press Sync on the board to bring your tasks in.' })
      } else {
        setNotice({ tone: 'error', text: result.message })
      }
    } catch {
      setNotice({ tone: 'error', text: 'The key could not be checked. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      await api.clearKey()
      window.dispatchEvent(new Event(DIS_INVOICE_KEY_CHANGED))
      setStatus(await api.status())
      setNotice({ tone: 'ok', text: 'Key removed. Your notes and projects stay as they are.' })
    } catch {
      setNotice({ tone: 'error', text: 'The key could not be removed. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection id="dis-invoice" title="dis-invoice" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.key}>
        <FieldRow
          label="Connector key"
          description={`Sync on the board reads your pending tasks with this key and never changes anything in dis-invoice. Create one in dis-invoice under Conector API. It can read every client's cards, so treat it like a password. ${status ? STORAGE_NOTE[status.storage] : ''}`}
          control={
            <div className="flex items-center gap-2">
              <Input
                id="dis-invoice-key"
                className="w-56"
                type="password"
                autoComplete="off"
                placeholder={status?.hasKey ? 'Key saved' : 'disck_…'}
                aria-label="Connector key"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value)
                  setNotice(null)
                }}
              />
              <Button disabled={!key.trim() || busy || status?.storage === 'unavailable'} onClick={() => void save()}>
                {busy ? 'Checking…' : 'Save'}
              </Button>
              {status?.hasKey && (
                <Button disabled={busy} onClick={() => void clear()}>
                  Remove
                </Button>
              )}
            </div>
          }
        />
      </SearchableRow>
      {notice && (
        <p role="status" className={notice.tone === 'error' ? 'text-danger text-[13px]' : 'text-muted text-[13px]'}>
          {notice.text}
        </p>
      )}
    </SettingsSection>
  )
}
