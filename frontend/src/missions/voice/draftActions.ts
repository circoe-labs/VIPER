import type { DraftAction, DraftRecord, DraftSnapshot } from '../../api/missionAssistant'
import type { MissionEndKind, MissionResultKind, RecurrenceUnit, TargetOption } from '../../api/missions'
import type { ContextRefDraft, MissionDraft, MissionFormApi } from '../useMissionForm'

// The form's state as the assistant reads it. Same fields, snake_case; `null` still means « follows the category ».
export function snapshotOf(form: MissionFormApi): DraftSnapshot {
  const record = (item: TargetOption): DraftRecord => ({ kind: item.kind, id: item.id, label: item.label, hint: item.hint })
  const missing = form.canSave
    ? null
    : (form.missing ?? (form.name.trim() === '' ? 'Il manque un nom.' : 'Il manque la consigne.'))
  return {
    name: form.name,
    category_id: form.category?.id ?? null,
    category_name: form.category?.name ?? null,
    result_kind: form.resultKind,
    prompt: form.promptOverride,
    skill_ids: form.skillIds,
    source_ids: form.sourceIds,
    targets: form.targets.map(record),
    context_refs: form.contextRefs.map(record),
    recurring: form.recurring,
    interval_count: form.intervalCount,
    interval_unit: form.unit,
    starts_at: form.startsAt,
    end_kind: form.endKind,
    ends_at: form.endsAt,
    max_runs: Number(form.maxRuns) || null,
    objective: form.objective,
    allow_multiple: form.allowMultiple,
    result_limit: Number(form.resultLimit) || 20,
    geography: form.geography,
    period_days: form.periodDays ? Number(form.periodDays) : null,
    exclude_known: form.excludeKnown,
    missing,
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
const ids = (value: unknown): string[] | null | undefined =>
  value === null ? null : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

function same(a: { kind: string; id: string }, b: { kind: string; id: string }) {
  return a.kind === b.kind && a.id === b.id
}

function recordOf(args: Record<string, unknown>): TargetOption | null {
  const kind = args.kind === 'company' || args.kind === 'prospect' ? args.kind : null
  const id = str(args.id)
  if (!kind || !id) return null
  return { kind, id, label: str(args.label) ?? id, hint: str(args.hint) ?? null }
}

// Folds the actions of one turn into ONE partial draft laid over the form (`form.applyDraft`): the same state a person
// edits by hand. Lists (targets, context) are built from what the form holds now, so several actions in a turn compose.
// The server already validated every action; unknown tools are ignored, never guessed.
export function draftFromActions(actions: readonly DraftAction[], form: MissionFormApi): MissionDraft {
  const draft: MissionDraft = {}
  let targets = form.targets
  let contextRefs: ContextRefDraft[] = form.contextRefs
  for (const { tool, args } of actions) {
    switch (tool) {
      case 'set_name':
        draft.name = str(args.name)
        break
      case 'set_category':
        draft.categoryId = str(args.category_id)
        draft.resultKind = str(args.result_kind) as MissionResultKind | undefined
        break
      case 'set_prompt':
        draft.prompt = args.prompt === null ? null : str(args.prompt)
        break
      case 'set_skills':
        draft.skillIds = ids(args.skill_ids)
        break
      case 'set_sources':
        draft.sourceIds = ids(args.source_ids)
        break
      case 'add_target': {
        const record = recordOf(args)
        if (record) targets = [...targets.filter((item) => !same(item, record)), record]
        draft.targets = targets
        break
      }
      case 'remove_target': {
        const record = recordOf(args)
        if (record) targets = targets.filter((item) => !same(item, record))
        draft.targets = targets
        break
      }
      case 'add_context_record': {
        const record = recordOf(args)
        if (record) contextRefs = [...contextRefs.filter((item) => !same(item, record)), { ...record, note: null }]
        draft.contextRefs = contextRefs
        break
      }
      case 'remove_context_record': {
        const record = recordOf(args)
        if (record) contextRefs = contextRefs.filter((item) => !same(item, record))
        draft.contextRefs = contextRefs
        break
      }
      case 'set_objective':
        if (args.kind === 'tasks_accepted' || args.kind === 'accepted_items') {
          draft.objective = { kind: args.kind, count: num(args.count) ?? null }
        }
        break
      case 'set_recurrence':
        draft.recurring = bool(args.recurring)
        draft.intervalCount = num(args.interval_count)
        draft.unit = str(args.interval_unit) as RecurrenceUnit | undefined
        draft.startsAt = str(args.starts_at)
        draft.endKind = str(args.end_kind) as MissionEndKind | undefined
        draft.endsAt = str(args.ends_at)
        draft.maxRuns = num(args.max_runs)
        break
      case 'set_options':
        draft.allowMultiple = bool(args.allow_multiple)
        draft.excludeKnown = bool(args.exclude_known)
        draft.resultLimit = num(args.result_limit)
        if ('geography' in args) draft.geography = str(args.geography) ?? ''
        if ('period_days' in args) draft.periodDays = num(args.period_days) ?? null
        break
    }
  }
  // `applyDraft` leaves `undefined` alone: drop the keys an action did not set.
  return Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined))
}
