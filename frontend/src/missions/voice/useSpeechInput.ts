import { useCallback, useEffect, useRef, useState } from 'react'

import { assistantErrorMessage, transcribeAudio } from '../../api/missionAssistant'

// Speech-to-text adapter of the voice mission assistant, local-first with a graceful fallback:
//   'server'  a Whisper-compatible service configured on the VIPER server (can be local); the browser records one
//             utterance, stops at the end of speech, the server transcribes it (final text only, no partials);
//   'browser' the browser's own SpeechRecognition (live partials; Chrome/Edge/Safari send the audio to their vendor);
//   'none'    nothing available: the overlay only offers typed text.
export type SpeechMode = 'server' | 'browser' | 'none'
export type SpeechState = 'idle' | 'listening' | 'transcribing'

// The subset of the (still prefixed) Web Speech API this adapter uses.
interface RecognitionResult {
  isFinal: boolean
  0: { transcript: string }
}
interface RecognitionEvent {
  resultIndex: number
  results: ArrayLike<RecognitionResult>
}
interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type RecognitionConstructor = new () => Recognition

function recognitionConstructor(): RecognitionConstructor | null {
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

export function chooseSpeechMode(serverSpeech: boolean): SpeechMode {
  const canRecord = typeof MediaRecorder !== 'undefined' && typeof navigator.mediaDevices.getUserMedia === 'function'
  if (serverSpeech && canRecord) return 'server'
  if (recognitionConstructor()) return 'browser'
  return 'none'
}

// A sentence for the person, from a getUserMedia / recognition failure.
export function micErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : typeof error === 'string' ? error : ''
  if (name === 'NotAllowedError' || name === 'not-allowed' || name === 'service-not-allowed' || name === 'SecurityError') {
    return 'L’accès au micro est refusé. Autorisez-le dans la barre d’adresse du navigateur, ou écrivez votre demande.'
  }
  if (name === 'NotFoundError' || name === 'audio-capture' || name === 'OverconstrainedError') {
    return 'Aucun micro détecté. Branchez-en un, ou écrivez votre demande.'
  }
  if (name === 'NotReadableError') return 'Le micro est utilisé par une autre application. Fermez-la, ou écrivez votre demande.'
  if (name === 'network') return 'La reconnaissance vocale du navigateur est injoignable. Écrivez votre demande, ou réessayez.'
  return 'Le micro n’a pas pu démarrer. Écrivez votre demande ou réessayez.'
}

// Endpointing for the server mode: speech above the threshold, the utterance ends after this much silence.
const SPEECH_LEVEL = 0.05
const SILENCE_MS = 1300
const NO_SPEECH_MS = 9000
const MAX_UTTERANCE_MS = 30_000

interface Options {
  mode: SpeechMode
  // The person finished a sentence.
  onFinal: (text: string) => void
  // Mic level 0..1 at animation rate (drives the orb without re-rendering).
  onLevel: (level: number) => void
  lang?: string
}

export function useSpeechInput({ mode, onFinal, onLevel, lang = 'fr-FR' }: Options) {
  const [state, setState] = useState<SpeechState>('idle')
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string | null>(null)
  const callbacks = useRef({ onFinal, onLevel })
  const cleanup = useRef<(() => void) | null>(null)
  const run = useRef(0)
  const finisher = useRef<(() => void) | null>(null)

  useEffect(() => {
    callbacks.current = { onFinal, onLevel }
  })

  const stop = useCallback(() => {
    run.current += 1
    cleanup.current?.()
    cleanup.current = null
    finisher.current = null
    callbacks.current.onLevel(0)
    setState('idle')
    setPartial('')
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(async () => {
    if (mode === 'none') return
    stop()
    setError(null)
    const mine = run.current
    const current = () => run.current === mine
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let frame = 0
    const release = () => {
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => {
        track.stop()
      })
      void context?.close().catch(() => undefined)
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (failure) {
      if (current()) setError(micErrorMessage(failure))
      return
    }
    if (!current()) {
      release()
      return
    }

    // The level meter (both modes): RMS of the time-domain signal.
    let level = 0
    const startedAt = performance.now()
    let heardAt = 0
    let spoke = false
    let endUtterance: () => void = () => undefined
    try {
      context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const tick = () => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += sample * sample
        level = Math.min(1, Math.sqrt(sum / samples.length) * 6)
        callbacks.current.onLevel(level)
        const now = performance.now()
        if (level > SPEECH_LEVEL) {
          spoke = true
          heardAt = now
        }
        if (mode === 'server') {
          const silent = spoke && now - heardAt > SILENCE_MS
          const idle = !spoke && now - startedAt > NO_SPEECH_MS
          if (silent || idle || now - startedAt > MAX_UTTERANCE_MS) {
            endUtterance()
            return
          }
        }
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    } catch {
      // No meter (AudioContext refused): the recognition still works, the orb just stays calm.
    }

    if (mode === 'browser') {
      const Ctor = recognitionConstructor()
      if (!Ctor) {
        release()
        setError(micErrorMessage('audio-capture'))
        return
      }
      const recognition = new Ctor()
      recognition.lang = lang
      recognition.interimResults = true
      recognition.continuous = false
      let finalText = ''
      recognition.onresult = (event) => {
        if (!current()) return
        let interim = ''
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          if (!result) continue
          if (result.isFinal) finalText += result[0].transcript
          else interim += result[0].transcript
        }
        setPartial((finalText + interim).trim())
      }
      recognition.onerror = (event) => {
        // `no-speech` / `aborted` are normal ends, not failures.
        if (current() && event.error !== 'no-speech' && event.error !== 'aborted') setError(micErrorMessage(event.error))
      }
      recognition.onend = () => {
        if (!current()) return
        release()
        cleanup.current = null
        setState('idle')
        setPartial('')
        callbacks.current.onLevel(0)
        const text = finalText.trim()
        if (text) callbacks.current.onFinal(text)
      }
      cleanup.current = () => {
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        recognition.abort()
        release()
      }
      finisher.current = () => {
        recognition.stop()
      }
      try {
        recognition.start()
        setState('listening')
      } catch (failure) {
        cleanup.current()
        cleanup.current = null
        setError(micErrorMessage(failure))
      }
      return
    }

    // Server mode: record the utterance, then send it to the Whisper-compatible service.
    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    const controller = new AbortController()
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = () => {
      release()
      if (!current()) return
      callbacks.current.onLevel(0)
      if (!spoke) {
        cleanup.current = null
        setState('idle')
        setError('Je ne vous entends pas. Touchez le micro pour réessayer, ou écrivez votre demande.')
        return
      }
      setState('transcribing')
      cleanup.current = () => {
        controller.abort()
      }
      transcribeAudio(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), controller.signal)
        .then((text) => {
          if (!current()) return
          cleanup.current = null
          setState('idle')
          if (text.trim()) callbacks.current.onFinal(text.trim())
          else setError('Je n’ai rien compris. Répétez, ou écrivez votre demande.')
        })
        .catch((failure: unknown) => {
          if (!current()) return
          cleanup.current = null
          setState('idle')
          setError(assistantErrorMessage(failure))
        })
    }
    endUtterance = () => {
      if (recorder.state !== 'inactive') recorder.stop()
    }
    cleanup.current = () => {
      recorder.ondataavailable = null
      recorder.onstop = null
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    }
    finisher.current = endUtterance
    recorder.start()
    setState('listening')
  }, [lang, mode, stop])

  // « J’ai fini » (tap on the orb while listening): ends the utterance now; what was heard is delivered.
  const finish = useCallback(() => {
    finisher.current?.()
  }, [])

  return {
    state,
    partial,
    error,
    start,
    stop,
    finish,
    clearError: () => {
      setError(null)
    },
  }
}
