import { useMissionSkills } from '../api/missionConfig'
import { useMissionAgents } from '../api/missions'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Checkbox, SelectField, TextField } from '../ui/fields'
import { PencilIcon, SlidersIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { SkillChecklist } from './ConfigPickers'
import './configPickers.css'
import { InheritanceNote } from './InheritanceNote'
import type { MissionFormApi } from './useMissionForm'

// « Skills » panel: the instruction skills the agent receives (the category's defaults until the mission picks its own),
// the agent that takes the tasks and the advanced run options. A skill is a block of instructions, never a tool.
export function MissionSkillsPanel({ form }: { form: MissionFormApi }) {
  const agents = useMissionAgents()
  const skills = useMissionSkills()
  const { category, skillIds } = form
  const inherited = skillIds === null
  const defaults = category?.skills ?? []
  return (
    <div className="mission-form__panel">
      <section className="mission-form__section">
        <h3 className="mission-form__title">
          <PencilIcon size={18} /> Skills
          <InfoTip label="Aide : skills">
            Des blocs de consignes réutilisables que l’agent reçoit avec la mission. Ils ne lui donnent aucun outil ni
            droit supplémentaire.
          </InfoTip>
        </h3>
        <InheritanceNote
          inherited={inherited}
          categoryName={category?.name}
          resetLabel="Revenir aux skills de la catégorie"
          onReset={() => {
            form.setSkillIds(null)
          }}
        />
        {inherited ? (
          <>
            {defaults.length > 0 ? (
              <ul className="cfg-chips" aria-label="Skills de la catégorie">
                {defaults.map((skill) => (
                  <li key={skill.id}>
                    <Badge>{skill.name}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="missions-muted">Cette catégorie n’a pas de skill par défaut.</p>
            )}
            <div>
              <Button
                size="sm"
                icon={PencilIcon}
                onClick={() => {
                  form.setSkillIds(defaults.map((skill) => skill.id))
                }}
              >
                Personnaliser les skills
              </Button>
            </div>
          </>
        ) : skills.isPending ? (
          <p className="missions-muted">Chargement des skills…</p>
        ) : skills.isError ? (
          <p className="missions-error" role="alert">
            Les skills n’ont pas pu être chargés.
          </p>
        ) : (
          <SkillChecklist skills={skills.data} value={skillIds} onChange={form.setSkillIds} />
        )}
      </section>

      <div className="mission-form__tipped">
        <SelectField
          label="Agent"
          value={form.agentId}
          onChange={(event) => {
            form.setAgentId(event.target.value)
          }}
        >
          <option value="">Automatique</option>
          {(agents.data ?? []).map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </SelectField>
        <span className="mission-form__tip">
          <InfoTip label="Aide : agent">
            Automatique : le premier agent connecté (Claude, ChatGPT…) qui sait exécuter ce type prend les tâches.
            Choisissez un agent pour lui réserver la mission.
          </InfoTip>
        </span>
      </div>

      <details className="mission-form__advanced">
        <summary>
          <SlidersIcon size={16} /> Options avancées
        </summary>
        <div className="mission-form__row">
          <TextField
            label="Zone géographique"
            value={form.geography}
            onChange={(event) => {
              form.setGeography(event.target.value)
            }}
            placeholder="Normandie, France, département…"
          />
          <SelectField
            label="Période recherchée"
            value={form.periodDays}
            onChange={(event) => {
              form.setPeriodDays(event.target.value)
            }}
          >
            <option value="">Indifférente</option>
            <option value="7">7 derniers jours</option>
            <option value="30">30 derniers jours</option>
            <option value="90">90 derniers jours</option>
          </SelectField>
        </div>
        <Checkbox
          label="Ignorer les sociétés déjà connues"
          checked={form.excludeKnown}
          onChange={(event) => {
            form.setExcludeKnown(event.target.checked)
          }}
        />
      </details>
    </div>
  )
}
