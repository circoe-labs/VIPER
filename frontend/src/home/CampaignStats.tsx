import { useContactDashboard } from "../api/contact";
import { sendMarkOf } from "../lib/campaign";

const RADIUS = 15.9155; // a circle of circumference 100: slice lengths read as percentages

// The pie's colour of each state: the follow-ups already sent, the first send, what is still to send.
const STATE_COLORS: Record<string, string> = {
  R2: "var(--color-danger-fg)",
  R1: "var(--color-warning-fg)",
  Envoyé: "var(--color-success-fg)",
  "À envoyer": "var(--color-info-fg)",
};
const STATES = ["R2", "R1", "Envoyé", "À envoyer"] as const;

interface Week {
  code: string;
  state: (typeof STATES)[number];
  detail: string;
  value: number;
}

// Where the campaign stands: how many prospects are in R2, R1, sent (first send) or still to send, and the same split
// week by week (one cohort = one week), as a pie. Counted from the cohorts of the base, so it follows what was imported.
export function CampaignStats() {
  const dashboard = useContactDashboard("");
  const weeks: Week[] = (dashboard.data?.cohorts ?? [])
    .filter((cohort) => !cohort.out_of_campaign && cohort.prospects > 0)
    .flatMap((cohort) => {
      const mark = sendMarkOf(cohort.code);
      if (!mark) return [];
      const state =
        mark.tone === "planned" ? "À envoyer" : (mark.label as Week["state"]);
      return [
        {
          code: cohort.code,
          state,
          detail: mark.tone === "planned" ? mark.label : state,
          value: cohort.prospects,
        },
      ];
    })
    .sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1)));
  const total = weeks.reduce((sum, week) => sum + week.value, 0);
  const byState = STATES.map((state) => ({
    state,
    value: weeks
      .filter((week) => week.state === state)
      .reduce((sum, week) => sum + week.value, 0),
  }));
  const starts = weeks.map((_, index) =>
    weeks
      .slice(0, index)
      .reduce((sum, week) => sum + (week.value / total) * 100, 0),
  );
  return (
    <section
      className="home-panel home-progress"
      aria-labelledby="home-campaign-title"
    >
      <header className="home-panel__header">
        <h2 id="home-campaign-title" className="home-panel__title">
          Campagne d’envoi
        </h2>
      </header>
      {total === 0 ? (
        <p className="home-panel__empty">
          Aucun prospect dans une semaine d’envoi pour le moment.
        </p>
      ) : (
        <>
          <ul className="campaign-totals">
            {byState.map(({ state, value }) => (
              <li key={state}>
                <span
                  className="month-pie__swatch"
                  style={{ background: STATE_COLORS[state] }}
                  aria-hidden="true"
                />
                {state} <strong>{value}</strong>
              </li>
            ))}
          </ul>
          <div className="month-pie">
            <svg
              viewBox="0 0 42 42"
              className="month-pie__chart"
              role="img"
              aria-label="Prospects par semaine d’envoi"
            >
              {weeks.map((week, index) => {
                const length = (week.value / total) * 100;
                const start = starts[index] ?? 0;
                return (
                  <circle
                    key={week.code}
                    cx="21"
                    cy="21"
                    r={RADIUS}
                    fill="none"
                    stroke={STATE_COLORS[week.state]}
                    strokeWidth="9"
                    strokeDasharray={`${String(length)} ${String(100 - length)}`}
                    strokeDashoffset={String(25 - start)}
                  />
                );
              })}
            </svg>
            <ul className="month-pie__legend">
              {weeks.map((week) => (
                <li key={week.code}>
                  <span
                    className="month-pie__swatch"
                    style={{ background: STATE_COLORS[week.state] }}
                    aria-hidden="true"
                  />
                  {week.code} · {week.detail} <strong>{week.value}</strong>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <p className="home-panel__note">
        Prospects de chaque semaine d’envoi : R2, R1, premier envoi fait, ou
        encore à envoyer.
      </p>
    </section>
  );
}
