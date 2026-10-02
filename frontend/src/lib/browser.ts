// Leaving the SPA for another site (the CIRCOE Toolbox's authorization page). Its own module so component tests can
// replace it: jsdom does not implement navigation. Only an absolute http(s) URL is followed (a `javascript:` or other
// scheme from a tampered answer is refused, never navigated to); the server checks the same rule on its side.
export function leaveFor(url: string): void {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new Error('Adresse de redirection invalide.')
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('Adresse de redirection refusée (https requis).')
  }
  window.location.assign(target.href)
}
