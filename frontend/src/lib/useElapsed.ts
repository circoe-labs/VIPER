import { useEffect, useState } from 'react'

// Whole seconds since `startedAt` (epoch ms), ticking every second; 0 while idle. Shown next to every wait the person
// watches (AI drafting, the Toolbox connection), so a slow answer never looks like a frozen page.
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}
