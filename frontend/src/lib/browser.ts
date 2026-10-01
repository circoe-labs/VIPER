// Leaving the SPA for another site (the CIRCOE Toolbox's authorization page). Its own module so component tests can
// replace it: jsdom does not implement navigation.
export function leaveFor(url: string): void {
  window.location.assign(url)
}
