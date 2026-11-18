import type { Prospect } from '../api/prospects'
import { AlertsSection } from './AlertsSection'
import { HistorySection, ProvenanceSection } from './ContextSections'
import type { SectionProps } from './EmploymentSections'
import { ProspectNotes } from './ProspectNotes'
import { SequenceSection } from './SequenceSection'
import { TrackingOverview } from './TrackingOverview'
import { TrackingSection } from './TrackingSection'
import './tracking-tab.css'

interface TrackingTabProps extends SectionProps {
  prospect: Prospect | null
  // The editor's form has unsaved changes (the sequence dialogs say they do not save them).
  dirty: boolean
  today: string
  // « Voir la note » of the score detail: the note to show and focus (ProspectNotes calls `onNoteShown` once done).
  noteToShow: string | null
  onNoteShown: () => void
  // A sequence or alert write succeeded: the editor reads the prospect again.
  onChanged: () => void
}

// The Suivi tab, composed scan-first (Slice 6): the overview band (state, next action, key dates), then two aligned
// rows of equal cards — what to do (state form | contact sequence) and what was said (notes | quality alerts) — and
// last the secondary record (provenance, history). Pure composition of the existing sections: no state, no rule.
export function TrackingTab({ draft, errors, fieldId, onChange, prospect, dirty, today, noteToShow, onNoteShown, onChanged }: TrackingTabProps) {
  return (
    <div className="tracking-tab">
      {prospect && <TrackingOverview prospect={prospect} tracking={draft.tracking} />}
      <div className="tracking-tab__grid">
        <TrackingSection draft={draft} errors={errors} fieldId={fieldId} onChange={onChange} prospect={prospect} />
        {prospect && <SequenceSection prospect={prospect} pendingChanges={dirty} onChanged={onChanged} />}
        {/* Notes are saved by their own API, outside this form (never dirty, never part of the version). */}
        <ProspectNotes prospectId={prospect?.id ?? null} today={today} showNoteId={noteToShow} onNoteShown={onNoteShown} />
        {prospect && <AlertsSection prospectId={prospect.id} onChanged={onChanged} />}
      </div>
      <div className="tracking-tab__grid tracking-tab__grid--secondary">
        <ProvenanceSection draft={draft} errors={errors} fieldId={fieldId} onChange={onChange} prospect={prospect} />
        {prospect && <HistorySection prospectId={prospect.id} />}
      </div>
    </div>
  )
}
