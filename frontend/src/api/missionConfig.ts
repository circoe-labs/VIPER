import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import type { MissionSource, MissionType, SkillRef, TargetOption } from './missions'
import { missionKeys } from './missions'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/mission_categories.py (categories, skills) and the source library part of
// routes/missions.py; contract in doc/architecture/missions.md §7c / §7d. Reads are open to any signed-in person;
// writes are an administrator's (403 `forbidden` otherwise, shown as the server's own sentence).

export interface SourceRef {
  id: string
  url: string
  label: string | null
}

export interface MissionCategory {
  id: string
  // Seeded categories carry their technical type here; they are edited, never deleted.
  key: string | null
  is_system: boolean
  name: string
  description: string | null
  // A glyph key (`shield-check`, see missions/categoryVisual.ts) and a `#rrggbb` colour.
  icon: string
  color: string
  general_prompt: string
  // Immutable after creation: how VIPER executes missions of the category.
  mission_type: MissionType
  position: number
  skills: SkillRef[]
  sources: SourceRef[]
  missions_count: number
}

export interface CategoryInput {
  name: string
  description: string | null
  icon: string
  color: string
  general_prompt: string
  mission_type: MissionType
  skill_ids: string[]
  source_ids: string[]
}

export interface MissionSkill {
  id: string
  name: string
  description: string | null
  content: string
  categories_count: number
  missions_count: number
}

export interface SkillInput {
  name: string
  description: string | null
  content: string
}

export interface CreatorPrompt {
  prompt: string
  default: string
  is_default: boolean
  source: 'ui' | 'env' | 'default'
}

export interface SourceFilters {
  q?: string
  order?: 'recent' | 'name' | 'uses'
}

export interface SourceInput {
  url: string
  label: string | null
  description: string | null
  parent_id: string | null
}

export const configKeys = {
  categories: ['missions', 'categories'] as const,
  skills: ['missions', 'skills'] as const,
  sources: (filters: SourceFilters) => ['missions', 'sources', 'library', filters] as const,
  creatorPrompt: ['missions', 'creator-prompt'] as const,
  contextCandidates: (kind: string, search: string) => ['missions', 'context-candidates', kind, search] as const,
}

export function useMissionCategories() {
  return useQuery({
    queryKey: configKeys.categories,
    queryFn: ({ signal }) => apiGet<MissionCategory[]>('/mission-categories', signal),
    refetchOnWindowFocus: false,
  })
}

export function useMissionSkills() {
  return useQuery({
    queryKey: configKeys.skills,
    queryFn: ({ signal }) => apiGet<MissionSkill[]>('/mission-skills', signal),
    refetchOnWindowFocus: false,
  })
}

// Category, skill and source edits change what missions show (card colour, inherited defaults): refresh them all.
const CONFIG_KEYS = [['missions']] as const

export function useSaveCategory(id: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CategoryInput) =>
      id
        ? apiRequest<MissionCategory>('PUT', `/mission-categories/${encodeURIComponent(id)}`, { body: input })
        : apiRequest<MissionCategory>('POST', '/mission-categories', { body: input }),
    onSuccess: () => refreshAfterWrite(queryClient, CONFIG_KEYS),
  })
}

export function useDeleteCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiRequest<undefined>('DELETE', `/mission-categories/${encodeURIComponent(id)}`),
    onSuccess: () => refreshAfterWrite(queryClient, CONFIG_KEYS),
  })
}

export function useSaveSkill(id: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SkillInput) =>
      id
        ? apiRequest<MissionSkill>('PUT', `/mission-skills/${encodeURIComponent(id)}`, { body: input })
        : apiRequest<MissionSkill>('POST', '/mission-skills', { body: input }),
    onSuccess: () => refreshAfterWrite(queryClient, CONFIG_KEYS),
  })
}

export function useDeleteSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiRequest<undefined>('DELETE', `/mission-skills/${encodeURIComponent(id)}`),
    onSuccess: () => refreshAfterWrite(queryClient, CONFIG_KEYS),
  })
}

// The whole library, flat (roots have `parent_id` null; nest client-side). `q` filters server-side.
export function useSourceLibrary(filters: SourceFilters = {}) {
  return useQuery({
    queryKey: configKeys.sources(filters),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (filters.q) params.set('q', filters.q)
      if (filters.order) params.set('order', filters.order)
      const text = params.toString()
      return apiGet<MissionSource[]>(`/missions/sources${text ? `?${text}` : ''}`, signal)
    },
    refetchOnWindowFocus: false,
  })
}

export function useCreateSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SourceInput) =>
      apiRequest<MissionSource>('POST', '/missions/sources', {
        body: { ...input, parent_id: input.parent_id ?? undefined },
      }),
    onSuccess: () => refreshAfterWrite(queryClient, [missionKeys.sources, ...CONFIG_KEYS]),
  })
}

// Administrators only: label, description and place in the hierarchy (`parent_id: null` makes it a root).
export function useUpdateSource(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Pick<SourceInput, 'label' | 'description' | 'parent_id'>) =>
      apiRequest<MissionSource>('PATCH', `/missions/sources/${encodeURIComponent(id)}`, { body: input }),
    onSuccess: () => refreshAfterWrite(queryClient, CONFIG_KEYS),
  })
}

export function useRemoveSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiRequest<undefined>('DELETE', `/missions/sources/${encodeURIComponent(id)}`),
    onSuccess: () => refreshAfterWrite(queryClient, CONFIG_KEYS),
  })
}

// What the mission-creator assistant is told (Slice 06 reads it; Paramètres › Assistant de mission edits it).
export function useCreatorPrompt() {
  return useQuery({
    queryKey: configKeys.creatorPrompt,
    queryFn: ({ signal }) => apiGet<CreatorPrompt>('/missions/creator-prompt', signal),
    refetchOnWindowFocus: false,
  })
}

// Internal VIPER records a mission may link as read-only context (never a target).
export function useContextCandidates(kind: 'company' | 'prospect', search: string, enabled: boolean) {
  return useQuery({
    queryKey: configKeys.contextCandidates(kind, search),
    queryFn: ({ signal }) =>
      apiGet<TargetOption[]>(
        `/missions/context-candidates?kind=${kind}&limit=20${search ? `&q=${encodeURIComponent(search)}` : ''}`,
        signal,
      ),
    enabled,
    refetchOnWindowFocus: false,
  })
}
