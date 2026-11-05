import { calendarMood } from './seasonal'

export function SeasonBanner({ day }: { day: string }) {
  const mood = calendarMood(day)
  return (
    <div className="agenda-season" role="group" aria-label={`Ambiance : ${mood.name}`}>
      <div className="agenda-season__intro">
        <span className="agenda-season__symbol" aria-hidden="true">{mood.symbol}</span>
        <div className="agenda-season__copy">
          <span className="agenda-season__name">{mood.name}</span>
          <span className="agenda-season__title">{mood.title}</span>
        </div>
      </div>
      <div className="agenda-season__decorations" aria-hidden="true">
        {mood.decorations.map((symbol, index) => <span key={index}>{symbol}</span>)}
      </div>
    </div>
  )
}
