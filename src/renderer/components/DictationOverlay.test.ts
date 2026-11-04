import { describe, expect, it } from 'vitest'
import { dictationMode, isAtRecordingCap, isProGateError, type DictationTarget } from './DictationOverlay'

const terminalTarget: DictationTarget = { kind: 'terminal', nodeId: 'n1', title: 'shell' }

// Press-to-talk: the pill is the only surface for a terminal target — the transcript is inserted
// straight into the terminal, so there is no editable card (chat nodes, which had one, are gone).
describe('dictationMode', () => {
  it('is "warning" whenever there is no target', () => {
    expect(dictationMode(null, true)).toBe('warning')
  })

  it('is "pill" for a terminal target', () => {
    expect(dictationMode(terminalTarget, true)).toBe('pill')
  })

  // Dictation off (Whisper + the explicit None selection, #143): never records. It wins over a
  // selected target too — otherwise the user speaks a whole take before transcribe refuses it,
  // which reads as broken instead of off.
  it('is "no-model" when dictation is off, target or not', () => {
    expect(dictationMode(terminalTarget, false)).toBe('no-model')
    expect(dictationMode(null, false)).toBe('no-model')
  })
})

// Base64 int16 PCM runs ~2.6 MB/min; WS_MAX_PAYLOAD (src/server/ws.ts) is 8 MiB, so an unbounded
// take would eventually blow the ws frame budget and drop the whole bridge. The 2:30 hard cap
// (MAX_RECORDING_MS) is what DictationOverlay's elapsed poller checks each tick to auto-stop
// well under that line — pin the boundary here since it isn't otherwise exercised by any test.
describe('isAtRecordingCap', () => {
  it('is false just under the 2:30 cap', () => {
    expect(isAtRecordingCap(149_999)).toBe(false)
  })

  it('is true exactly at the cap', () => {
    expect(isAtRecordingCap(150_000)).toBe(true)
  })

  it('is true past the cap', () => {
    expect(isAtRecordingCap(200_000)).toBe(true)
  })
})

// SpeechService.transcribeNow throws `The ${info.id} model requires nodeterm Pro — the tiny
// model is free.` for a Pro-gated model on a free account — DictationOverlay matches that shape
// to show a "See nodeterm Pro" action beside the inline error, so pin the substring match here.
describe('isProGateError', () => {
  it('matches the Pro-gate error thrown by SpeechService', () => {
    expect(isProGateError('The base model requires DisTerm Pro — the tiny model is free.')).toBe(
      true
    )
  })

  it('does not match an unrelated transcribe error', () => {
    expect(isProGateError('Transcription failed.')).toBe(false)
    expect(isProGateError('No speech detected.')).toBe(false)
    expect(isProGateError('Download the base model in Settings → Speech first.')).toBe(false)
  })
})
