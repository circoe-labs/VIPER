import { isDirty, type ProspectDraft } from './prospectForm'

// Where the Prospect editor's fields live (Task 03): which tab shows them, and which Profil section reads them. Pure
// helpers so the read/edit state stays a view over the one draft (no second copy of the data).

export type EditorTab = 'profile' | 'tracking'

// Sections of the Profil tab that read as a summary until edited.
export type EditableSection = 'identity' | 'employment' | 'emails' | 'phones'

// The section of a field path (the API's paths, with draft indexes): `emails.1.address` → `emails`.
export function sectionOfField(path: string): EditableSection | null {
  if (path === 'first_name' || path === 'last_name' || path === 'civility') return 'identity'
  if (path.startsWith('emails.')) return 'emails'
  if (path.startsWith('phones.')) return 'phones'
  if (
    path === 'company_id' ||
    path === 'role_id' ||
    path === 'exact_job_title' ||
    path === 'activity_status' ||
    path.startsWith('employment_verification')
  ) {
    return 'employment'
  }
  return null
}

// Contact tracking and provenance are the Suivi tab's fields; everything else is on Profil.
export function tabOfField(path: string): EditorTab {
  return path.startsWith('tracking.') || path.startsWith('provenance.') ? 'tracking' : 'profile'
}

// Sections that must open as inputs: those whose fields are already invalid (a section with an error is never
// hidden behind a summary).
export function sectionsWithErrors(errors: Record<string, string>): EditableSection[] {
  const sections = new Set<EditableSection>()
  for (const path of Object.keys(errors)) {
    const section = sectionOfField(path)
    if (section) sections.add(section)
  }
  return [...sections]
}

export function tabsWithErrors(errors: Record<string, string>): Record<EditorTab, boolean> {
  const tabs = { profile: false, tracking: false }
  for (const path of Object.keys(errors)) tabs[tabOfField(path)] = true
  return tabs
}

// Unsaved changes per tab: the draft with the other tab's fields put back to their baseline, compared as a payload.
export function dirtyTabs(draft: ProspectDraft, baseline: ProspectDraft, isNew: boolean): Record<EditorTab, boolean> {
  const trackingOf = (source: ProspectDraft) => ({
    tracking: source.tracking,
    legal_context: source.legal_context,
    source_reference: source.source_reference,
  })
  return {
    profile: isDirty({ ...draft, ...trackingOf(baseline) }, baseline, isNew),
    tracking: isDirty({ ...baseline, ...trackingOf(draft) }, baseline, isNew),
  }
}
