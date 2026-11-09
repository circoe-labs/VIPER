import { Link } from 'react-router'

import './opportunities.css'

const opportunities = [
  {
    company: 'SCANormande (E.Leclerc)', location: 'Hauts-de-Glos / Lisieux (14)', score: 94,
    signal: 'Premi?re pierre, le 17/09/2026, d?un entrep?t frais m?canis? CLEM : investissement de 40 M?, deux trieurs et environ 50 AMR.',
    sources: 'SCANormande ; presse sectorielle',
    need: 'Accompagnement op?rationnel de l?automatisation : flux, interfaces m?tiers, conduite du changement et indicateurs.',
    service: 'Optimisation des flux ? ?tude et pilotage des flux intralogistiques. Compl?ment : transformation digitale.',
    decisionMaker: 'Direction logistique / direction de site / responsable automatisation',
    action: 'Identifier le responsable projet CLEM et proposer un ?change de cadrage ind?pendant sur les flux cibles et la mise en service.',
  },
  {
    company: 'Sofrilog', location: 'Caen (14), r?seau national', score: 93,
    signal: 'Offre active v?rifi?e le 09/11/2026 : d?ploiement d?un nouveau TMS dans toutes les agences, impliquant conception, param?trage, donn?es, tests et formation.',
    sources: 'Offre Sofrilog ; miroir Welcome to the Jungle',
    need: 'Renfort possible sur la cartographie des processus transport, la qualit? des donn?es, la recette et l?adoption terrain.',
    service: 'Transformation digitale ? assistance au d?ploiement TMS et conduite du changement.',
    decisionMaker: 'Direction Organisation, M?thodes & Process / DSI / direction transport',
    action: 'Qualifier l??tape r?elle du programme et le p?rim?tre des agences pilotes avant toute approche.',
  },
  {
    company: 'Hanseatic Global Terminals', location: 'Le Havre (76)', score: 89,
    signal: 'Demande d?occupation publi?e le 06/10/2026 pour les hangars 86/87 et 3 772 m? de terrain, afin d?exercer une activit? de manutention portuaire ? partir du 01/01/2027.',
    sources: 'Avis HAROPA',
    need: 'Conception des flux d?exploitation, organisation des interfaces quai/terre et dimensionnement des moyens.',
    service: 'Optimisation des flux ? am?nagement et optimisation d?un site logistique portuaire.',
    decisionMaker: 'Direction terminal / direction op?rations France / responsable projets',
    action: 'V?rifier l?attribution d?finitive de la COT puis proposer un diagnostic de flux pr?-d?marrage.',
  },
  {
    company: 'Log?S / Alpine', location: 'Dieppe (76)', score: 87,
    signal: 'Nouvelle plateforme Log?S de 11 000 m?, inaugur?e le 15/10/2026, d?di?e aux flux de pi?ces vers la manufacture Alpine ; 2 500 r?f?rences concern?es.',
    sources: 'Log?S ; La Gazette Normandie, 14/10',
    need: 'Stabilisation des flux de r?approvisionnement, performance du ? dernier kilom?tre ? industriel et indicateurs de service.',
    service: 'Optimisation des flux ? optimisation de r?seau et flux usine-entrep?t.',
    decisionMaker: 'Directeur de site Log?S / responsable logistique Alpine Dieppe',
    action: 'Prendre contact apr?s la phase de d?marrage pour qualifier les irritants de mont?e en charge.',
  },
  {
    company: 'S?nalia', location: 'V.PARK, Le Havre (76)', score: 85,
    signal: 'Prise ? bail annonc?e le 26/10/2026 : S?nalia occupera la derni?re cellule du V.PARK ; mise en service attendue fin 2026.',
    sources: 'Virtuo ; VoxLog',
    need: 'Organisation d?implantation, d?finition des flux et des processus d?exploitation du nouveau site.',
    service: 'Optimisation des flux ? am?nagement et d?marrage d?entrep?t.',
    decisionMaker: 'Direction logistique / direction industrielle / responsable projet immobilier-logistique',
    action: 'Identifier le p?rim?tre op?rationnel transf?r? et le calendrier de mise en route.',
  },
  {
    company: 'ALepetit', location: 'Saint-Romain-de-Colbosc (76)', score: 73,
    signal: 'Communication publi?e r?cemment sur un nouvel entrep?t finalis? en avril, con?u pour accro?tre la capacit? et optimiser l?organisation.',
    sources: 'ALepetit ; Groupe SCHL',
    need: 'Optimisation post-implantation des stocks, zones, parcours et processus de pr?paration.',
    service: 'Optimisation des flux ? diagnostic d?am?nagement et de performance d?entrep?t.',
    decisionMaker: 'Direction g?n?rale / responsable exploitation ou logistique',
    action: 'Non renseign?e.',
  },
]

export function OpportunitiesPage() {
  return <div className="opportunities">
    <header className="opportunities__header">
      <div><Link to="/">? Accueil</Link><h1>Opportunit?s ? explorer</h1><p>Six pistes de prospection en Normandie, class?es selon le score fourni.</p></div>
    </header>
    <p className="opportunities__notice">Informations fournies le 9 novembre 2026. Les besoins sont des hypoth?ses ; les scores et les signaux sont repris tels que communiqu?s. Les liens des sources n?ont pas ?t? fournis.</p>
    <div className="opportunities__list">
      {opportunities.map((item) => <article className="opportunity" key={item.company}>
        <header className="opportunity__header"><div><h2>{item.company}</h2><p>{item.location}</p></div><span className="opportunity__score" aria-label={`Score ${item.score} sur 100`}>{item.score}<small> / 100</small></span></header>
        <dl className="opportunity__details">
          <div className="opportunity__signal"><dt>Signal communiqu?</dt><dd>{item.signal}<span className="opportunity__sources">Sources cit?es : {item.sources}. Lien non fourni.</span></dd></div>
          <div><dt>Besoin suppos?</dt><dd>{item.need}</dd></div>
          <div><dt>Pilier et prestation CIRCOE</dt><dd>{item.service}</dd></div>
          <div><dt>D?cideur fonctionnel ? cibler</dt><dd>{item.decisionMaker}</dd></div>
          <div><dt>Prochaine action</dt><dd>{item.action}</dd></div>
        </dl>
      </article>)}
    </div>
  </div>
}
