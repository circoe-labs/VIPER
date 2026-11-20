
import { mascotSource } from '../brand/mascots'
import './opportunities.css'

const opportunities = [
  {
    company: 'SCANormande (E.Leclerc)', location: 'Hauts-de-Glos / Lisieux (14)', score: 94,
    signal: 'Première pierre, le 17/09/2026, d’un entrepôt frais mécanisé CLEM : investissement de 40 M€, deux trieurs et environ 50 AMR.',
    sources: 'SCANormande ; presse sectorielle',
    need: 'Accompagnement opérationnel de l’automatisation : flux, interfaces métiers, conduite du changement et indicateurs.',
    service: 'Optimisation des flux — étude et pilotage des flux intralogistiques. Complément : transformation digitale.',
    decisionMaker: 'Direction logistique / direction de site / responsable automatisation',
    action: 'Identifier le responsable projet CLEM et proposer un échange de cadrage indépendant sur les flux cibles et la mise en service.',
  },
  {
    company: 'Sofrilog', location: 'Caen (14), réseau national', score: 93,
    signal: 'Offre active vérifiée le 09/11/2026 : déploiement d’un nouveau TMS dans toutes les agences, impliquant conception, paramétrage, données, tests et formation.',
    sources: 'Offre Sofrilog ; miroir Welcome to the Jungle',
    need: 'Renfort possible sur la cartographie des processus transport, la qualité des données, la recette et l’adoption terrain.',
    service: 'Transformation digitale — assistance au déploiement TMS et conduite du changement.',
    decisionMaker: 'Direction Organisation, Méthodes & Process / DSI / direction transport',
    action: 'Qualifier l’étape réelle du programme et le périmètre des agences pilotes avant toute approche.',
  },
  {
    company: 'Hanseatic Global Terminals', location: 'Le Havre (76)', score: 89,
    signal: 'Demande d’occupation publiée le 06/10/2026 pour les hangars 86/87 et 3 772 m² de terrain, afin d’exercer une activité de manutention portuaire à partir du 01/01/2027.',
    sources: 'Avis HAROPA',
    need: 'Conception des flux d’exploitation, organisation des interfaces quai/terre et dimensionnement des moyens.',
    service: 'Optimisation des flux — aménagement et optimisation d’un site logistique portuaire.',
    decisionMaker: 'Direction terminal / direction opérations France / responsable projets',
    action: 'Vérifier l’attribution définitive de la COT puis proposer un diagnostic de flux pré-démarrage.',
  },
  {
    company: 'Log’S / Alpine', location: 'Dieppe (76)', score: 87,
    signal: 'Nouvelle plateforme Log’S de 11 000 m², inaugurée le 15/10/2026, dédiée aux flux de pièces vers la manufacture Alpine ; 2 500 références concernées.',
    sources: 'Log’S ; La Gazette Normandie, 14/10',
    need: 'Stabilisation des flux de réapprovisionnement, performance du « dernier kilomètre » industriel et indicateurs de service.',
    service: 'Optimisation des flux — optimisation de réseau et flux usine-entrepôt.',
    decisionMaker: 'Directeur de site Log’S / responsable logistique Alpine Dieppe',
    action: 'Prendre contact après la phase de démarrage pour qualifier les irritants de montée en charge.',
  },
  {
    company: 'Sénalia', location: 'V.PARK, Le Havre (76)', score: 85,
    signal: 'Prise à bail annoncée le 26/10/2026 : Sénalia occupera la dernière cellule du V.PARK ; mise en service attendue fin 2026.',
    sources: 'Virtuo ; VoxLog',
    need: 'Organisation d’implantation, définition des flux et des processus d’exploitation du nouveau site.',
    service: 'Optimisation des flux — aménagement et démarrage d’entrepôt.',
    decisionMaker: 'Direction logistique / direction industrielle / responsable projet immobilier-logistique',
    action: 'Identifier le périmètre opérationnel transféré et le calendrier de mise en route.',
  },
  {
    company: 'ALepetit', location: 'Saint-Romain-de-Colbosc (76)', score: 73,
    signal: 'Communication publiée récemment sur un nouvel entrepôt finalisé en avril, conçu pour accroître la capacité et optimiser l’organisation.',
    sources: 'ALepetit ; Groupe SCHL',
    need: 'Optimisation post-implantation des stocks, zones, parcours et processus de préparation.',
    service: 'Optimisation des flux — diagnostic d’aménagement et de performance d’entrepôt.',
    decisionMaker: 'Direction générale / responsable exploitation ou logistique',
    action: 'Non renseignée.',
  },
]

export function OpportunitiesPage() {
  return <div className="opportunities">
    <header className="opportunities__header">
      <div className="opportunities__intro"><img className="opportunities__mascot" src={mascotSource('idea')} alt="" /><div><h1>Opportunités à explorer</h1><p>Six pistes de prospection en Normandie, classées selon le score fourni.</p></div></div>
    </header>
    <p className="opportunities__notice">Informations fournies le 9 novembre 2026. Les besoins sont des hypothèses ; les scores et les signaux sont repris tels que communiqués. Les liens des sources n’ont pas été fournis.</p>
    <div className="opportunities__list">
      {opportunities.map((item) => <article className="opportunity" key={item.company}>
        <header className="opportunity__header"><div><h2>{item.company}</h2><p>{item.location}</p></div><span className="opportunity__score" aria-label={`Score ${item.score} sur 100`}>{item.score}<small> / 100</small></span></header>
        <dl className="opportunity__details">
          <div className="opportunity__signal"><dt>Signal communiqué</dt><dd>{item.signal}<span className="opportunity__sources">Sources citées : {item.sources}. Lien non fourni.</span></dd></div>
          <div><dt>Besoin supposé</dt><dd>{item.need}</dd></div>
          <div><dt>Pilier et prestation CIRCOE</dt><dd>{item.service}</dd></div>
          <div><dt>Décideur fonctionnel à cibler</dt><dd>{item.decisionMaker}</dd></div>
          <div><dt>Prochaine action</dt><dd>{item.action}</dd></div>
        </dl>
      </article>)}
    </div>
  </div>
}
