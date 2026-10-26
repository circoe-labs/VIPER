import type { SendMoment } from './MailEditor'
import { scheduleToIso } from './mailModel'

// The date and time last chosen with « Programmer les mails » (per step), kept in this browser so the mail editors
// and the next series start from it instead of an empty field. Only a moment still in the future is given back.
const KEY = 'viper.contact.lastMoment'

function read(): Record<string, SendMoment> {
  try {
    const raw = window.localStorage.getItem(KEY)
    const value: unknown = raw ? JSON.parse(raw) : {}
    return typeof value === 'object' && value !== null ? (value as Record<string, SendMoment>) : {}
  } catch {
    return {}
  }
}

export function rememberMoment(step: string, moment: SendMoment): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...read(), [step]: moment }))
  } catch {
    // Storage unavailable (private window): the field simply starts empty next time.
  }
}

export function rememberedMoment(step: string): SendMoment {
  const moment = read()[step]
  if (moment && scheduleToIso(moment.date, moment.time, new Date()).ok) return moment
  return { date: '', time: '' }
}
