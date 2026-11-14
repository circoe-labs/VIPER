import { useCallback, useEffect, useRef, useState } from 'react'

import { assistantErrorMessage, assistantTurn, type ChatMessage } from '../../api/missionAssistant'
import type { MissionFormApi } from '../useMissionForm'
import { draftFromActions, snapshotOf } from './draftActions'
import { type SpeechMode, useSpeechInput } from './useSpeechInput'

export const GREETING = 'Décrivez la mission que vous voulez créer.'

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking'

interface Options {
  form: MissionFormApi
  mode: SpeechMode
  // The form's own save (ordinary validation + `POST /missions`): the only way a mission gets created.
  submit: () => void
  // Closes the overlay (the draft stays in the form).
  close: () => void
  onLevel: (level: number) => void
}

// Dictation, not a spoken conversation (nothing is ever read out): what the person says (spoken or typed) goes to the assistant with the form's current draft; the
// actions it proposes are laid over the SAME form (`applyDraft`); a clear « crée / go » asks the form to save, which
// still refuses an incomplete draft. Nothing here writes to the server except the assistant turn (which writes nothing).
export function useVoiceConversation({ form, mode, submit, close, onLevel }: Options) {
  const [assistantText, setAssistantText] = useState(GREETING)
  const [transcript, setTranscript] = useState('')
  const [applied, setApplied] = useState<string[]>([])
  const [thinking, setThinking] = useState(false)
  const [turnError, setTurnError] = useState<string | null>(null)
  const [finalizeAsked, setFinalizeAsked] = useState(false)
  const [failedText, setFailedText] = useState<string | null>(null)

  const live = useRef({ form, submit, close })
  const history = useRef<ChatMessage[]>([])
  const busy = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    live.current = { form, submit, close }
  })

  const speech = useSpeechInput({
    mode,
    onLevel,
    onFinal: (text) => {
      void send(text)
    },
  })
  const { start: startListening, stop: stopListening } = speech

  // Opens the microphone again (the greeting at opening, and after a refused « crée »).
  const listen = useCallback(() => {
    if (mounted.current && mode !== 'none') void startListening()
  }, [mode, startListening])

  async function send(text: string) {
    const said = text.trim()
    if (!said || busy.current) return
    busy.current = true
    stopListening()
    setTranscript(said)
    setApplied([])
    setTurnError(null)
    setFailedText(null)
    setFinalizeAsked(false)
    setThinking(true)
    const asked = [...history.current, { role: 'user' as const, content: said }]
    controller.current = new AbortController()
    try {
      const result = await assistantTurn(asked, snapshotOf(live.current.form), controller.current.signal)
      if (!mounted.current) return
      const draft = draftFromActions(result.actions, live.current.form)
      if (Object.keys(draft).length > 0) live.current.form.applyDraft(draft)
      history.current = [...asked, { role: 'assistant', content: result.reply }]
      setApplied(result.actions.map((action) => action.summary))
      setAssistantText(result.reply)
      if (result.finalize) setFinalizeAsked(true)
    } catch (failure) {
      if (!mounted.current || (failure instanceof DOMException && failure.name === 'AbortError')) return
      setFailedText(said)
      setTurnError(assistantErrorMessage(failure))
    } finally {
      busy.current = false
      if (mounted.current) setThinking(false)
    }
  }

  // The assistant asked to create. The form decides, after the turn's edits are in it: saveable -> its own save; else
  // the missing piece is said (derived below) and the conversation carries on.
  const blocked = finalizeAsked && !form.canSave
  const blockedText = blocked
    ? `Je ne peux pas encore la créer. ${form.missing ?? (form.name.trim() === '' ? 'Il manque un nom.' : 'Il manque la consigne.')}`
    : null
  useEffect(() => {
    if (!finalizeAsked) return
    const { form: current, submit: save, close: leave } = live.current
    if (current.canSave) {
      leave()
      save()
      return
    }
    const why = current.missing ?? (current.name.trim() === '' ? 'Il manque un nom.' : 'Il manque la consigne.')
    const text = `Je ne peux pas encore la créer. ${why}`
    history.current = [...history.current, { role: 'assistant', content: text }]
    listen()
  }, [finalizeAsked, form.canSave, listen])

  useEffect(() => {
    mounted.current = true
    listen()
    const abort = controller
    return () => {
      mounted.current = false
      abort.current?.abort()
    }
    // Once, when the overlay opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const phase: VoicePhase = thinking
    ? 'thinking'
    : speech.state === 'transcribing'
      ? 'transcribing'
      : speech.state === 'listening'
        ? 'listening'
        : 'idle'

  return {
    phase,
    assistantText: blockedText ?? assistantText,
    // What the person is saying now (live) or said last.
    transcript: speech.partial || transcript,
    live: speech.partial !== '',
    applied,
    error: turnError ?? speech.error,
    // The typed fallback and the « Réessayer » of a failed turn.
    sendText: (text: string) => {
      void send(text)
    },
    retry: () => {
      if (failedText) void send(failedText)
      else {
        speech.clearError()
        void startListening()
      }
    },
    canRetry: turnError !== null && failedText !== null,
    dismissError: () => {
      setTurnError(null)
      speech.clearError()
    },
    // The microphone: listen, or end the sentence now.
    toggleListening: () => {
      if (mode === 'none') return
      if (speech.state === 'listening') speech.finish()
      else void startListening()
    },
  }
}
