// Reserved place of the « Score prospect » card (Task 04), top of the Profil tab's right column. Deliberately empty
// until the score UI lands: it takes no room (`:empty` in profile-summary.css) and shows nothing half-finished. Task 04
// replaces its body; the slot, its name and its position stay.
export function ProspectScoreCard() {
  return <div className="prospect-score-slot" data-slot="prospect-score" />
}
