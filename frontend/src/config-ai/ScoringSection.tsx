import { Link } from 'react-router'

import { evaluationFailure, useScoringTest } from '../api/scoreEvaluation'
import { useElapsed } from '../lib/useElapsed'
import { useState } from 'react'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, PlayIcon, SparklesIcon, TargetIcon } from '../ui/icons'
import { PromptGrid, type PromptCopy } from '../settings/PromptSection'
import { signedDelta } from '../prospects/scoreView'
import './scoring.css'

// Config AI › Scoring prospect: what the AI is told when it scores a prospect (« Évaluer le score »). The key and the model are
// the ones of Connexions (no second field here). Two texts use the same editor as the other prompts (reset to the built-in
// text, same 8 000 characters): the system prompt and the Circoe target the score is measured against. The answer format and the
// « adéquation commerciale uniquement » rule are fixed by the code, so editing the prompt cannot break the contract.
const SCORING_PROMPT: PromptCopy = {
  field: 'prospect_scoring_prompt',
  defaultOf: (data) => data.prospect_scoring_prompt_default,
  id: 'settings-prompt-scoring',
  card: 'Évaluer un prospect',
  icon: SparklesIcon,
  title: 'Consigne du score prospect',
  subtitle: 'Donné à l’IA avant chaque évaluation de score',
  sentence:
    'Expliquez à l’IA comment juger un prospect : ce qu’elle pèse (fonction, entreprise, signaux) et comment elle justifie. Le format de la réponse (score, justification, critères) et la règle « adéquation commerciale uniquement » sont ajoutés automatiquement et ne se modifient pas.',
  label: 'Consigne d’évaluation',
  saved: 'Consigne enregistrée : elle s’applique aux prochaines évaluations.',
}

const CIRCOE_TARGET: PromptCopy = {
  field: 'circoe_target',
  defaultOf: (data) => data.circoe_target_default,
  id: 'settings-prompt-circoe-target',
  card: 'Cible de Circoe',
  icon: TargetIcon,
  title: 'Cible de Circoe',
  subtitle: 'Le client idéal, que le score mesure',
  sentence:
    'Décrivez qui Circoe veut comme client et comme interlocuteur : secteur, taille, fonctions, ce qui rend un prospect intéressant ou non. Le score dit à quel point une fiche correspond à ce texte.',
  label: 'Cible de Circoe',
  saved: 'Cible enregistrée : elle s’applique aux prochaines évaluations.',
}

export function ScoringSection() {
  return (
    <div className="scoring">
      <p className="scoring__lead">
        L’IA lit la fiche complète d’un prospect (sans les relations ni l’état du contact) et donne un score de 0 à 100 : à quel point on aimerait l’avoir
        comme client. La clé et le modèle sont ceux de <Link to="/config-ai/connections">Connexions</Link>.
      </p>
      <PromptGrid prompts={[SCORING_PROMPT, CIRCOE_TARGET]} />
      <ScoringTest />
    </div>
  )
}

// « Tester sur un prospect »: the SAVED prompt and target on the latest prospect, nothing stored on it.
function ScoringTest() {
  const test = useScoringTest()
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const elapsed = useElapsed(startedAt)
  const result = test.data

  function run() {
    setStartedAt(Date.now())
    test.mutate(undefined, {
      onSettled: () => {
        setStartedAt(null)
      },
    })
  }

  return (
    <section className="scoring-test" aria-label="Tester sur un prospect">
      <div className="scoring-test__head">
        <div>
          <h3 className="scoring-test__title">Tester sur un prospect</h3>
          <p className="scoring-test__hint">Lance le prompt et la cible enregistrés sur le dernier prospect modifié. Rien n’est enregistré sur la fiche.</p>
        </div>
        <Button icon={PlayIcon} loading={test.isPending} onClick={run}>
          {test.isPending ? `Évaluation… ${String(elapsed)} s` : 'Tester sur un prospect'}
        </Button>
      </div>
      {test.isError && (
        <p className="scoring-test__error" role="alert">
          <AlertIcon size={16} />
          {evaluationFailure(test.error)}
        </p>
      )}
      {result && (
        <div className="scoring-test__result" role="status">
          <p className="scoring-test__verdict">
            <CheckCircleIcon size={16} />
            <strong>{result.prospect_name}</strong> : <strong>{result.score}</strong> sur 100
          </p>
          <p className="scoring-test__rationale">{result.rationale}</p>
          <ul className="scoring-test__criteria" aria-label="Critères">
            {result.criteria.map((criterion) => (
              <li key={`${criterion.label}-${criterion.evidence}`}>
                <span className="scoring-test__delta" data-sign={Math.sign(criterion.delta)}>
                  {signedDelta(criterion.delta)}
                </span>
                <span>
                  {criterion.label} <span className="scoring-test__evidence">— {criterion.evidence}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="scoring-test__meta">
            Modèle {result.model} · prompt {result.prompt_version} · {(result.duration_ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s
          </p>
        </div>
      )}
    </section>
  )
}
