import { useState } from 'react'

import { type MissionCategory, useMissionCategories } from '../api/missionConfig'
import {
  type MissionDetail,
  type MissionEndKind,
  type MissionInput,
  type MissionResultKind,
  type MissionType,
  type RecurrenceUnit,
  type TargetOption,
  useMissionOptions,
} from '../api/missions'
import {
  kindOf,
  kindSpec,
  MISSION_KINDS,
  type MissionKindSpec,
  missingForRun,
  TASK_COUNT_MAX,
  taskPlan,
} from './missionKinds'

// A context record linked to the mission (read-only, never a target). `note` is kept so an edit does not erase it.
export interface ContextRefDraft extends TargetOption {
  note: string | null
}

// What a person (or, in Slice 06, the voice assistant) can pre-fill in the mission form. Every field is optional:
// what is not mentioned keeps its current value. Inheritable fields (`prompt`, `skillIds`, `sourceIds`) follow the
// category while `undefined`; `null` says « follow the category again », a value says « override ».
export interface MissionDraft {
  name?: string
  categoryId?: string
  resultKind?: MissionResultKind
  prompt?: string | null
  skillIds?: string[] | null
  sourceIds?: string[] | null
  targets?: TargetOption[]
  contextRefs?: ContextRefDraft[]
  agentId?: string
  recurring?: boolean
  intervalCount?: number
  unit?: RecurrenceUnit
  startsAt?: string
  endKind?: MissionEndKind
  endsAt?: string
  maxRuns?: number
  taskCount?: number
  geography?: string
  periodDays?: number | null
  excludeKnown?: boolean
}

// An ISO moment as a `datetime-local` value (the person's own clock), '' for none.
export function localInput(iso: string | null): string {
  if (!iso) return ''
  const moment = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(moment.getFullYear())}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}`
}

export function suggestion(prompt: string): string {
  const first = prompt.trim().split('\n')[0] ?? ''
  const cleaned = first.replace(/[.;:,]+$/, '').trim()
  if (cleaned.length <= 60) return cleaned
  return `${cleaned.slice(0, 57)}…`
}

export function kindsForType(type: MissionType | undefined): MissionKindSpec[] {
  return MISSION_KINDS.filter((kind) => kind.type === type)
}

// The category a mission without one (a row older than the categories) belongs to: the built-in category of its type.
function categoryOfMission(mission: MissionDetail | undefined, categories: readonly MissionCategory[]) {
  if (!mission) return undefined
  const id = mission.card.category?.id ?? mission.inheritance?.category_id
  return (
    categories.find((category) => category.id === id) ??
    categories.find((category) => category.mission_type === mission.card.type && category.key === mission.card.type)
  )
}

// All the state of « Créer mission » / « Modifier la mission », kept out of the view so the dialog, its sections and
// the voice assistant (Slice 06, through `applyDraft`) share one source of truth. `toInput()` builds the API body:
//
//   - `prompt`, `skill_ids`, `source_ids` are `null` while the mission follows its category and a value once the
//     person overrides them (server contract: doc/architecture/missions.md §7c / §7d);
//   - `context_refs` are read-only internal records, distinct from `targets`.
export function useMissionForm(mission?: MissionDetail, initial?: MissionDraft) {
  const categoriesQuery = useMissionCategories()
  const options = useMissionOptions()
  const categories = categoriesQuery.data ?? []
  const card = mission?.card
  const rule = mission?.rule
  const inheritance = mission?.inheritance
  const editing = mission !== undefined

  const [name, setName] = useState(initial?.name ?? card?.name ?? '')
  const [nameTouched, setNameTouched] = useState(editing || initial?.name !== undefined)
  const [categoryChoice, setCategoryChoice] = useState<string | null>(initial?.categoryId ?? null)
  const [resultKindChoice, setResultKindChoice] = useState<MissionResultKind | null>(
    initial?.resultKind ?? mission?.result_kind ?? null,
  )
  // Without `inheritance` (an older answer) the mission's own values count as overrides, as before categories existed.
  const [promptOverride, setPromptOverride] = useState<string | null>(
    initial?.prompt !== undefined
      ? initial.prompt
      : mission
        ? inheritance?.prompt_inherited === true
          ? null
          : mission.prompt
        : null,
  )
  const [skillIds, setSkillIds] = useState<string[] | null>(
    initial?.skillIds !== undefined
      ? initial.skillIds
      : mission
        ? inheritance?.skills_inherited === true
          ? null
          : (mission.skills ?? []).map((skill) => skill.id)
        : null,
  )
  const [sourceIds, setSourceIds] = useState<string[] | null>(
    initial?.sourceIds !== undefined
      ? initial.sourceIds
      : mission
        ? inheritance?.sources_inherited === true
          ? null
          : mission.sources.map((source) => source.id)
        : null,
  )
  const [targets, setTargets] = useState<TargetOption[]>(
    initial?.targets ??
      mission?.targets.map((target) => ({ kind: target.kind, id: target.id, label: target.label, hint: target.hint })) ??
      [],
  )
  const [contextRefs, setContextRefs] = useState<ContextRefDraft[]>(
    initial?.contextRefs ??
      (mission?.context_refs ?? []).map((ref) => ({ kind: ref.kind, id: ref.id, label: ref.label, hint: ref.hint, note: ref.note })),
  )
  const [agentId, setAgentId] = useState(initial?.agentId ?? rule?.agent_id ?? '')
  const [recurring, setRecurring] = useState(initial?.recurring ?? card?.is_recurring ?? false)
  const [intervalCount, setIntervalCount] = useState(initial?.intervalCount ?? card?.interval_count ?? 24)
  const [unit, setUnit] = useState<RecurrenceUnit>(initial?.unit ?? card?.interval_unit ?? 'hours')
  const [startsAt, setStartsAt] = useState(initial?.startsAt ?? localInput(rule?.starts_at ?? null))
  const [endKind, setEndKind] = useState<MissionEndKind>(initial?.endKind ?? rule?.end_kind ?? 'never')
  const [endsAt, setEndsAt] = useState(initial?.endsAt ?? localInput(rule?.ends_at ?? null))
  const [maxRuns, setMaxRuns] = useState(String(initial?.maxRuns ?? rule?.max_runs ?? 10))
  // What the person typed in « Nombre de tâches »; null = untouched (the natural count applies).
  const [taskCountText, setTaskCountText] = useState<string | null>(() => {
    const value = initial?.taskCount ?? rule?.task_count
    return value === undefined ? null : String(value)
  })
  const [geography, setGeography] = useState(initial?.geography ?? rule?.geography ?? '')
  const [periodDays, setPeriodDays] = useState(
    initial?.periodDays != null ? String(initial.periodDays) : rule?.period_days ? String(rule.period_days) : '',
  )
  const [excludeKnown, setExcludeKnown] = useState(initial?.excludeKnown ?? rule?.exclusions.known_companies === true)

  // The category in force: the chosen one, else the mission's own, else the default for a new mission (enrichment).
  const category: MissionCategory | undefined =
    categories.find((item) => item.id === categoryChoice) ??
    categoryOfMission(mission, categories) ??
    categories.find((item) => item.key === 'enrichment') ??
    categories[0]
  const type = category?.mission_type
  const kinds = kindsForType(type)
  const kind =
    kinds.find((item) => item.resultKind === resultKindChoice) ??
    (mission && type === mission.card.type ? kindSpec(kindOf(mission.card.type, mission.result_kind)) : undefined) ??
    kinds[0]
  const resultKind: MissionResultKind = kind?.resultKind ?? 'enrichment'

  const executable =
    type !== undefined &&
    (options.data?.types.find((item) => item.value === type)?.executable ?? true) &&
    (options.data?.result_kinds.find((item) => item.value === resultKind)?.executable ?? true)

  const plan = taskPlan(type ?? 'other', targets)
  // Untouched: one task, or one per linked company.
  const taskCount = plan.fixed ? String(plan.count) : (taskCountText ?? String(plan.minimum))
  const wanted = Number(taskCount)
  const taskCountMissing = plan.fixed
    ? null
    : !Number.isInteger(wanted) || wanted < 1 || wanted > TASK_COUNT_MAX
      ? `Indiquez un nombre de tâches entre 1 et ${String(TASK_COUNT_MAX)}.`
      : wanted < plan.minimum
        ? `Au moins une tâche par société liée (${String(plan.minimum)}).`
        : null
  const effectivePrompt = promptOverride ?? category?.general_prompt ?? ''
  const filled = name.trim() !== '' && effectivePrompt.trim() !== ''
  // Mirrors the server: a rule that could never produce a task is not saved (it used to be, then sat paused).
  const missing: string | null =
    type === undefined
      ? 'Choisissez une catégorie.'
      : !executable
        ? 'Ce type de mission n’est pas encore exécutable : choisissez-en un autre.'
        : (missingForRun(type, resultKind, targets) ?? taskCountMissing)
  const ready = missing === null
  const canSave = filled && ready

  const setPrompt = (text: string) => {
    // Empty = follow the category's general prompt again.
    setPromptOverride(text === '' ? null : text)
    if (!nameTouched) setName(suggestion(text))
  }

  const chooseCategory = (id: string) => {
    setCategoryChoice(id)
    setResultKindChoice(null)
  }

  // Slice 06 seam: lays a (partial) draft over the form. Unmentioned fields are left alone; a touched name stops the
  // automatic suggestion.
  const applyDraft = (draft: MissionDraft) => {
    if (draft.name !== undefined) {
      setName(draft.name)
      setNameTouched(true)
    }
    if (draft.categoryId !== undefined) chooseCategory(draft.categoryId)
    if (draft.resultKind !== undefined) setResultKindChoice(draft.resultKind)
    if (draft.prompt !== undefined) setPromptOverride(draft.prompt)
    if (draft.skillIds !== undefined) setSkillIds(draft.skillIds)
    if (draft.sourceIds !== undefined) setSourceIds(draft.sourceIds)
    if (draft.targets !== undefined) setTargets(draft.targets)
    if (draft.contextRefs !== undefined) setContextRefs(draft.contextRefs)
    if (draft.agentId !== undefined) setAgentId(draft.agentId)
    if (draft.recurring !== undefined) setRecurring(draft.recurring)
    if (draft.intervalCount !== undefined) setIntervalCount(draft.intervalCount)
    if (draft.unit !== undefined) setUnit(draft.unit)
    if (draft.startsAt !== undefined) setStartsAt(draft.startsAt)
    if (draft.endKind !== undefined) setEndKind(draft.endKind)
    if (draft.endsAt !== undefined) setEndsAt(draft.endsAt)
    if (draft.maxRuns !== undefined) setMaxRuns(String(draft.maxRuns))
    if (draft.taskCount !== undefined) setTaskCountText(String(draft.taskCount))
    if (draft.geography !== undefined) setGeography(draft.geography)
    if (draft.periodDays !== undefined) setPeriodDays(draft.periodDays === null ? '' : String(draft.periodDays))
    if (draft.excludeKnown !== undefined) setExcludeKnown(draft.excludeKnown)
  }

  const toInput = (): MissionInput => {
    const input: MissionInput = {
      name: name.trim(),
      type: type ?? 'other',
      category_id: category?.id ?? null,
      // null = follow the category (the server copies its general prompt / default skills / default sources).
      prompt: promptOverride === null ? null : promptOverride.trim(),
      skill_ids: skillIds,
      source_ids: sourceIds,
      targets: targets.flatMap((target) => (target.kind === 'warehouse' ? [] : [{ kind: target.kind, id: target.id }])),
      context_refs: contextRefs.map((ref) => ({ kind: ref.kind, id: ref.id, note: ref.note })),
      agent_id: agentId || null,
      is_recurring: recurring,
      interval_count: intervalCount,
      interval_unit: unit,
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      end_kind: recurring ? endKind : 'never',
      ends_at: recurring && endKind === 'date' && endsAt ? new Date(endsAt).toISOString() : null,
      max_runs: recurring && endKind === 'after' ? Number(maxRuns) : null,
      result_kind: resultKind,
      task_count: Number(taskCount),
      geography: geography.trim() || null,
      period_days: periodDays ? Number(periodDays) : null,
      exclusions: { ...(rule?.exclusions ?? {}), known_companies: excludeKnown },
      run_now: false,
    }
    if (!excludeKnown) delete input.exclusions.known_companies
    return input
  }

  return {
    editing,
    categoriesQuery,
    categories,
    category,
    chooseCategory,
    kinds,
    kind,
    setResultKind: setResultKindChoice,
    resultKind,
    options: options.data,
    name,
    setName: (value: string) => {
      setNameTouched(true)
      setName(value)
    },
    // The consigne the mission has by itself (null = the category's general prompt applies).
    promptOverride,
    setPrompt,
    effectivePrompt,
    skillIds,
    setSkillIds,
    sourceIds,
    setSourceIds,
    targets,
    setTargets,
    contextRefs,
    setContextRefs,
    agentId,
    setAgentId,
    recurring,
    setRecurring,
    intervalCount,
    setIntervalCount,
    unit,
    setUnit,
    startsAt,
    setStartsAt,
    endKind,
    setEndKind,
    endsAt,
    setEndsAt,
    maxRuns,
    setMaxRuns,
    plan,
    taskCount,
    setTaskCount: setTaskCountText,
    geography,
    setGeography,
    periodDays,
    setPeriodDays,
    excludeKnown,
    setExcludeKnown,
    type,
    missing,
    ready,
    canSave,
    applyDraft,
    toInput,
  }
}

export type MissionFormApi = ReturnType<typeof useMissionForm>
