// VIPER mascot, one pose per section. Cut out from the handoff sheet; alpha preserved, no background box.
import build from '../assets/mascot/build.png'
import checklist from '../assets/mascot/checklist.png'
import contact from '../assets/mascot/contact.png'
import hello from '../assets/mascot/hello.png'
import idea from '../assets/mascot/idea.png'
import mission from '../assets/mascot/mission.png'
import search from '../assets/mascot/search.png'
import stats from '../assets/mascot/stats.png'

const MASCOTS = { build, checklist, contact, hello, idea, mission, search, stats }

export type MascotName = keyof typeof MASCOTS

export function mascotSource(name: MascotName): string {
  return MASCOTS[name]
}
