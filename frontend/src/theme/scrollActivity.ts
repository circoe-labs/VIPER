// Drives the Apple-style scrollbars of theme/base.css. Chromium does not restyle a custom scrollbar when its host
// gets `:hover`, so two attributes are set from script instead:
// - `data-scroll-hover` on the scrollable ancestors of the element under the pointer (the page itself excluded);
// - `data-scrolling` on an element for a moment after it scrolled (scroll events do not bubble: one capturing
//   listener covers the whole page), so its scrollbar shows while it scrolls, like macOS overlay scrollbars.
const HIDE_AFTER_MS = 900
const timers = new WeakMap<Element, number>()

function scrollable(element: Element): boolean {
  const style = getComputedStyle(element)
  const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll'
  return (
    (scrolls(style.overflowY) && element.scrollHeight > element.clientHeight) ||
    (scrolls(style.overflowX) && element.scrollWidth > element.clientWidth)
  )
}

export function installScrollActivity(doc: Document = document): () => void {
  let hovered: Element[] = []
  const onOver = (event: Event) => {
    const chain: Element[] = []
    for (let node = event.target instanceof Element ? event.target : null; node; node = node.parentElement) {
      if (node === doc.documentElement || node === doc.body) break
      if (scrollable(node)) chain.push(node)
    }
    for (const node of hovered) if (!chain.includes(node)) node.removeAttribute('data-scroll-hover')
    for (const node of chain) node.setAttribute('data-scroll-hover', '')
    hovered = chain
  }
  const onLeave = () => {
    for (const node of hovered) node.removeAttribute('data-scroll-hover')
    hovered = []
  }
  const onScroll = (event: Event) => {
    const target = event.target instanceof Document ? event.target.documentElement : event.target
    if (!(target instanceof Element)) return
    target.setAttribute('data-scrolling', '')
    window.clearTimeout(timers.get(target))
    timers.set(
      target,
      window.setTimeout(() => {
        target.removeAttribute('data-scrolling')
      }, HIDE_AFTER_MS),
    )
  }
  doc.addEventListener('pointerover', onOver, { passive: true })
  doc.documentElement.addEventListener('pointerleave', onLeave, { passive: true })
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => {
    doc.removeEventListener('pointerover', onOver)
    doc.documentElement.removeEventListener('pointerleave', onLeave)
    doc.removeEventListener('scroll', onScroll, { capture: true })
  }
}
