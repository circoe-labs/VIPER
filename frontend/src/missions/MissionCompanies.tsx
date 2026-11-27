import { useState } from 'react'

import { Button } from '../ui/Button'
import { BuildingIcon, CloseIcon, PlusIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { TargetPicker } from './TargetPicker'
import type { MissionFormApi } from './useMissionForm'

// « Trouver des contacts »: the companies the contacts are searched in. They are the mission's targets (the tasks are
// spread over them), unlike « Contexte VIPER » which is only read. Shown also when a mission already holds targets under
// another prospection result, so they can be removed.
export function MissionCompanies({ form }: { form: MissionFormApi }) {
  const [picking, setPicking] = useState(false)
  const { targets, type, resultKind } = form
  if (type !== 'prospection' || (resultKind !== 'prospects' && targets.length === 0)) return null
  return (
    <section className="mission-form__section">
      <h3 className="mission-form__title">
        <BuildingIcon size={18} /> Sociétés où chercher
        <InfoTip label="Aide : sociétés où chercher">
          Les agents cherchent des contacts dans ces sociétés ; les tâches sont réparties entre elles.
        </InfoTip>
      </h3>
      {targets.length > 0 && (
        <ul className="mission-targets" aria-label="Sociétés où chercher">
          {targets.map((target) => (
            <li key={`${target.kind}:${target.id}`} className="mission-target">
              <span className="mission-target__label">{target.label}</span>
              <button
                type="button"
                className="mission-target__remove"
                aria-label={`Retirer ${target.label} (société)`}
                onClick={() => {
                  form.setTargets(targets.filter((item) => item !== target))
                }}
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon={PlusIcon}
          onClick={() => {
            setPicking(true)
          }}
        >
          Ajouter des sociétés
        </Button>
      </div>
      <TargetPicker
        open={picking}
        companiesOnly
        onClose={() => {
          setPicking(false)
        }}
        onAdd={(added) => {
          const seen = new Set(targets.map((target) => target.id))
          form.setTargets([...targets, ...added.filter((item) => !seen.has(item.id))])
        }}
      />
    </section>
  )
}
