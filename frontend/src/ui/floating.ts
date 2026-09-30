import { type RefObject, useEffect, useLayoutEffect, useState } from 'react'

const VIEWPORT_MARGIN = 8

export interface Point {
  x: number
  y: number
}

// Places a fixed-position element at `point`, shifted back inside the viewport once its size is known — and again
// whenever that size changes (content loaded after opening, e.g. the quick week planner).
export function useViewportClamp(ref: RefObject<HTMLElement | null>, point: Point, alignRight = false) {
  const [position, setPosition] = useState<Point>(point)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    function clamp(target: HTMLElement) {
      const { width, height } = target.getBoundingClientRect()
      const left = alignRight ? point.x - width : point.x
      setPosition({
        x: Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN)),
        y: Math.max(VIEWPORT_MARGIN, Math.min(point.y, window.innerHeight - height - VIEWPORT_MARGIN)),
      })
    }
    clamp(element)
    // Absent from jsdom: the first placement is then the only one.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      clamp(element)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [ref, point.x, point.y, alignRight])

  return position
}

// Calls `onOutside` on a pointer press outside `ref` (and outside `ignore`, e.g. the toggle that opened it).
export function useOutsidePress(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  ignore?: HTMLElement | null,
) {
  useEffect(() => {
    function handle(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (ref.current?.contains(target) || ignore?.contains(target)) return
      onOutside()
    }
    document.addEventListener('pointerdown', handle, true)
    return () => {
      document.removeEventListener('pointerdown', handle, true)
    }
  }, [ref, onOutside, ignore])
}

// Remembers what had focus when the floating element opened and gives it back when it closes.
export function useRestoreFocus() {
  useEffect(() => {
    const previouslyFocused = document.activeElement
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus()
    }
  }, [])
}
