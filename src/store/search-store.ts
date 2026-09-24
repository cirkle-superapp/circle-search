/**
 * search-store.ts
 * -----------------------------------------------------------------------------
 * Client-side state for CIRKLE. Uses Zustand.
 *
 * Responsibilities:
 *   - Hold the current query / mode / filters / results / loading state.
 *   - Execute searches by POSTing to /api/search (relative path — the gateway
 *     forwards it). No absolute URLs anywhere.
 *   - Hydrate from URL params (?q= ?mode= ?freshness= etc.) on mount.
 *   - Push state into URL via window.history.replaceState (NO router.push —
 *     that would cause a full re-render / re-fetch in some Next setups).
 *   - Persist mode + filters (except page) to localStorage when
 *     personalization is ON; in private mode, never persist.
 *   - Drive autocomplete (debounced 200ms GET /api/suggest?q=).
 *   - Open / close the Filters Sheet and the Deep Research Sheet.
 *   - Fetch a source profile for SourceProfileDialog.
 *   - Trigger the seed crawler when the index is empty.
 *   - Load /api/stats for the IndexStatusBar.
 *
 * This module is pure client-side — no Prisma, no LLM client.
 * -----------------------------------------------------------------------------
 */

'use client'

import { create } from 'zustand'
import type {
  AiMode,
  IndexStats,
  Personalization,
  SafeSearch,
  SearchFilters,
  SearchMode,
  SearchLens,
  SearchResponse,
  SeedCrawlResponse,
  SourceProfile,
  StatsResponse,
  SuggestResponse,
  ResearchReport,
  Freshness,
  AILayer,
} from '@/components/search/types'

// --- Saved search (localStorage-only) --------------------------------------

export interface SavedSearch {
  id: string
  query: string
  mode: SearchMode
  filters: SearchFilters
  savedAt: string
  resultCount?: number
}

// --- Defaults -------------------------------------------------------------

export const DEFAULT_FILTERS: SearchFilters = {
  freshness: 'ANY',
  sourceTypes: [],
  domainDiversity: 2,
  aiMode: 'AUTO',
  personalization: 'OFF',
  safeSearch: 'ON',
  page: 1,
  pageSize: 10,
}

export const DEFAULT_MODE: SearchMode = 'BALANCED'

/**
 * Default search lens — BALANCED (no perspective bias). The Devil's Advocate
 * lens is selected only when the user explicitly clicks it.
 */
export const DEFAULT_LENS: SearchLens = 'BALANCED'

// --- Store shape ----------------------------------------------------------

interface SearchState {
  // Core state
  query: string
  mode: SearchMode
  lens: SearchLens
  filters: SearchFilters
  results: SearchResponse | null
  loading: boolean
  error: string | null

  // UI panels
  showFilters: boolean
  showResearch: boolean
  showSourceProfile: string | null // docId when open
  showSavedSearches: boolean
  showCommandPalette: boolean

  // Autocomplete
  autocompleteOpen: boolean
  autocompleteItems: string[]
  autocompleteLoading: boolean

  // Research
  research: ResearchReport | null
  researchLoading: boolean
  researchError: string | null

  // Lazy AI layer (fetched after results render so the SERP appears fast)
  aiLayerLoading: boolean

  // Stats / source profile cache
  stats: StatsResponse | null
  sourceProfile: SourceProfile | null
  sourceProfileLoading: boolean
  sourceProfileError: string | null

  // Saved searches (localStorage-only — privacy-respecting, no server sync
  // unless the user explicitly enables personalization in the future).
  savedSearches: SavedSearch[]

  // Recent searches (localStorage-only, only recorded when personalization
  // is ON — in private mode, nothing is recorded). Shown in the autocomplete
  // when the search box is empty + focused.
  recentSearches: string[]

  // Internal: store a debounce timer handle for autocomplete.
  _autocompleteTimer: ReturnType<typeof setTimeout> | null
  _hydrated: boolean

  // Actions
  setQuery: (q: string) => void
  setMode: (m: SearchMode) => void
  setLens: (l: SearchLens) => void
  setFilters: (patch: Partial<SearchFilters>) => void
  resetFilters: () => void
  toggleFilter: () => void
  toggleResearch: () => void
  openSourceProfile: (docId: string | null) => void
  toggleSavedSearches: () => void
  setShowCommandPalette: (open: boolean) => void
  toggleCommandPalette: () => void

  executeSearch: () => Promise<void>
  loadAutocomplete: (prefix: string) => void
  selectAutocomplete: (suggestion: string) => Promise<void>
  setAutocompleteOpen: (open: boolean) => void

  runResearch: () => Promise<void>
  loadAILayer: () => Promise<void>
  loadSourceProfile: (id: string) => Promise<SourceProfile | null>
  triggerSeedCrawl: (urls?: string[]) => Promise<SeedCrawlResponse | null>
  loadStats: () => Promise<void>

  // Saved searches
  saveCurrentSearch: () => void
  deleteSavedSearch: (id: string) => void
  applySavedSearch: (id: string) => void
  loadSavedSearches: () => void

  // Recent searches
  loadRecentSearches: () => void
  recordRecentSearch: (q: string) => void
  clearRecentSearches: () => void

  hydrateFromUrl: () => Promise<void>
  _writeUrl: () => void
  _persistPrefs: () => void
  _loadPrefs: () => void
}

// --- Helpers ---------------------------------------------------------------

const LS_KEY = 'cirkle-prefs'
const LS_SAVED_KEY = 'cirkle-saved-searches'
const LS_RECENT_KEY = 'cirkle-recent-searches'

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined'
}

/**
 * Push current query/mode/lens/filters state into the URL via history.replaceState.
 * We DO NOT use the Next router — that would trigger a full re-render and
 * potentially re-fetch in some configurations.
 *
 * URL params emitted:
 *   ?q=        query
 *   ?mode=     SearchMode
 *   ?lens=     SearchLens (only emitted when not BALANCED — keeps URLs clean)
 *   ?freshness= Freshness
 *   ?src=      comma-separated source types (only if non-empty)
 *   ?diversity= domainDiversity (0|1|2|3)
 *   ?ai=       aiMode
 *   ?pers=     personalization
 *   ?safe=     safeSearch
 *   ?lang=     language (if set)
 *   ?country=  country (if set)
 *   ?page=     page (only if > 1)
 */
function writeUrl(state: {
  query: string
  mode: SearchMode
  lens: SearchLens
  filters: SearchFilters
}) {
  if (!isBrowser()) return
  const params = new URLSearchParams()
  if (state.query.trim()) params.set('q', state.query.trim())
  params.set('mode', state.mode)
  if (state.lens && state.lens !== 'BALANCED') params.set('lens', state.lens)
  params.set('freshness', state.filters.freshness)
  if (state.filters.sourceTypes.length > 0) {
    params.set('src', state.filters.sourceTypes.join(','))
  }
  params.set('diversity', String(state.filters.domainDiversity))
  params.set('ai', state.filters.aiMode)
  params.set('pers', state.filters.personalization)
  params.set('safe', state.filters.safeSearch)
  if (state.filters.language) params.set('lang', state.filters.language)
  if (state.filters.country) params.set('country', state.filters.country)
  if (state.filters.page > 1) params.set('page', String(state.filters.page))
  if (state.filters.freshness === 'CUSTOM') {
    if (state.filters.freshnessCustomStart) {
      params.set('from', state.filters.freshnessCustomStart)
    }
    if (state.filters.freshnessCustomEnd) {
      params.set('to', state.filters.freshnessCustomEnd)
    }
  }
  const search = params.toString()
  const newUrl = search ? `/?${search}` : '/'
  try {
    window.history.replaceState(null, '', newUrl)
  } catch {
    // ignore — some sandboxed iframes block this
  }
}

function parseFiltersFromUrl(): {
  query: string
  mode: SearchMode
  lens: SearchLens
  filters: Partial<SearchFilters>
} {
  if (!isBrowser()) return { query: '', mode: DEFAULT_MODE, lens: DEFAULT_LENS, filters: {} }
  const params = new URLSearchParams(window.location.search)
  const query = params.get('q') ?? ''
  const modeParam = params.get('mode') as SearchMode | null
  const validModes: SearchMode[] = [
    'BALANCED',
    'EXACT',
    'LATEST',
    'RESEARCH',
    'OFFICIAL',
    'ACADEMIC',
    'COMMUNITY',
    'NEWS',
    'IMAGES',
  ]
  const mode: SearchMode =
    modeParam && validModes.includes(modeParam) ? modeParam : DEFAULT_MODE
  const lensParam = params.get('lens') as SearchLens | null
  const validLenses: SearchLens[] = [
    'BALANCED',
    'ACADEMIC',
    'NEWS',
    'PRIMARY',
    'COMMUNITY',
    'COMMERCIAL',
    'DEVILS_ADVOCATE',
  ]
  const lens: SearchLens =
    lensParam && validLenses.includes(lensParam) ? lensParam : DEFAULT_LENS
  const filters: Partial<SearchFilters> = {}

  const freshness = params.get('freshness') as Freshness | null
  const validFresh: Freshness[] = ['ANY', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR', 'CUSTOM']
  if (freshness && validFresh.includes(freshness)) filters.freshness = freshness

  const src = params.get('src')
  if (src) {
    const arr = src
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) =>
        ['OFFICIAL', 'GOVERNMENT', 'ACADEMIC', 'NEWS', 'COMMUNITY', 'COMMERCIAL', 'PRIMARY', 'WEB'].includes(s),
      )
    if (arr.length > 0) filters.sourceTypes = arr as SearchFilters['sourceTypes']
  }

  const div = params.get('diversity')
  if (div === '0' || div === '1' || div === '2' || div === '3') {
    filters.domainDiversity = parseInt(div, 10) as 0 | 1 | 2 | 3
  }

  const ai = params.get('ai') as AiMode | null
  if (ai && ['AUTO', 'ON', 'OFF'].includes(ai)) filters.aiMode = ai

  const pers = params.get('pers') as Personalization | null
  if (pers && ['ON', 'OFF'].includes(pers)) filters.personalization = pers

  const safe = params.get('safe') as SafeSearch | null
  if (safe && ['ON', 'OFF'].includes(safe)) filters.safeSearch = safe

  const lang = params.get('lang')
  if (lang) filters.language = lang

  const country = params.get('country')
  if (country) filters.country = country

  const page = parseInt(params.get('page') ?? '1', 10)
  if (!Number.isNaN(page) && page > 0) filters.page = page

  const from = params.get('from')
  const to = params.get('to')
  if (from) filters.freshnessCustomStart = from
  if (to) filters.freshnessCustomEnd = to

  return { query, mode, lens, filters }
}

// --- Store ----------------------------------------------------------------

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  mode: DEFAULT_MODE,
  lens: DEFAULT_LENS,
  filters: { ...DEFAULT_FILTERS },
  results: null,
  loading: false,
  error: null,

  showFilters: false,
  showResearch: false,
  showSourceProfile: null,
  showSavedSearches: false,
  showCommandPalette: false,

  autocompleteOpen: false,
  autocompleteItems: [],
  autocompleteLoading: false,

  research: null,
  researchLoading: false,
  researchError: null,

  aiLayerLoading: false,

  stats: null,
  sourceProfile: null,
  sourceProfileLoading: false,
  sourceProfileError: null,

  savedSearches: [],

  recentSearches: [],

  _autocompleteTimer: null,
  _hydrated: false,

  setQuery: (q) => {
    set({ query: q })
  },

  setMode: (m) => {
    set({ mode: m, filters: { ...get().filters, page: 1 } })
    get()._persistPrefs()
    // If we're already in an active results view, re-run with the new mode.
    if (get().results || get().query.trim()) {
      void get().executeSearch()
    } else {
      get()._writeUrl()
    }
  },

  setLens: (l) => {
    set({ lens: l, filters: { ...get().filters, page: 1 } })
    get()._persistPrefs()
    // If we're already in an active results view, re-run with the new lens.
    // This is what makes the SearchLenses UI feel "live" — clicking a lens
    // immediately re-ranks the result cards.
    if (get().results || get().query.trim()) {
      void get().executeSearch()
    } else {
      get()._writeUrl()
    }
  },

  setFilters: (patch) => {
    const next = { ...get().filters, ...patch }
    if (
      patch.freshness !== undefined &&
      patch.freshness !== 'CUSTOM'
    ) {
      // reset custom range if leaving CUSTOM
      next.freshnessCustomStart = undefined
      next.freshnessCustomEnd = undefined
    }
    if (
      patch.sourceTypes !== undefined ||
      patch.freshness !== undefined ||
      patch.domainDiversity !== undefined ||
      patch.aiMode !== undefined ||
      patch.language !== undefined ||
      patch.country !== undefined
    ) {
      // Any structural filter change resets the page.
      next.page = 1
    }
    set({ filters: next })
    get()._persistPrefs()
  },

  resetFilters: () => {
    const reset = { ...DEFAULT_FILTERS }
    // Preserve personalization (private mode is sticky — privacy default).
    reset.personalization = get().filters.personalization
    set({ filters: reset })
    get()._persistPrefs()
    void get().executeSearch()
  },

  toggleFilter: () => set({ showFilters: !get().showFilters }),
  toggleSavedSearches: () => set({ showSavedSearches: !get().showSavedSearches }),
  setShowCommandPalette: (open) => set({ showCommandPalette: open }),
  toggleCommandPalette: () => set({ showCommandPalette: !get().showCommandPalette }),
  toggleResearch: () => {
    const willOpen = !get().showResearch
    set({ showResearch: willOpen })
    if (willOpen && !get().research && get().query.trim()) {
      void get().runResearch()
    }
  },
  openSourceProfile: (docId) => {
    set({ showSourceProfile: docId, sourceProfile: null, sourceProfileError: null })
    if (docId) void get().loadSourceProfile(docId)
  },

  executeSearch: async () => {
    const state = get()
    const q = state.query.trim()
    if (!q) {
      set({ results: null, error: null })
      get()._writeUrl()
      return
    }
    set({ loading: true, error: null })
    try {
      const body = {
        query: q,
        mode: state.mode,
        lens: state.lens,
        filters: state.filters,
      }
      const resp = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(
          `Search failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
        )
      }
      const data = (await resp.json()) as SearchResponse
      set({ results: data, loading: false, aiLayerLoading: true })
      get()._writeUrl()
      // Record this search in recent-searches (only if personalization is ON —
      // the recordRecentSearch action itself checks + no-ops in private mode).
      get().recordRecentSearch(q)
      // Refresh stats too — index may have changed behind us.
      void get().loadStats()
      // --- Lazy AI layer: fetch the AI answer + knowledge card + related
      // questions SEPARATELY so the user sees results in ~1s, then AI streams
      // in after. This fixes the "13 seconds before anything shows" problem.
      void get().loadAILayer()
    } catch (e: any) {
      set({
        loading: false,
        error: e?.message ?? 'Search failed for an unknown reason.',
      })
    }
  },

  loadAutocomplete: (prefix) => {
    const trimmed = prefix.trim()
    const existing = get()._autocompleteTimer
    if (existing) clearTimeout(existing)

    if (!trimmed) {
      set({
        autocompleteItems: [],
        autocompleteLoading: false,
        autocompleteOpen: false,
      })
      return
    }

    set({ autocompleteLoading: true, autocompleteOpen: true })

    const timer = setTimeout(async () => {
      try {
        const resp = await fetch(
          `/api/suggest?q=${encodeURIComponent(trimmed)}`,
          { headers: { Accept: 'application/json' } },
        )
        if (!resp.ok) {
          set({ autocompleteItems: [], autocompleteLoading: false })
          return
        }
        const data = (await resp.json()) as SuggestResponse
        set({
          autocompleteItems: data.suggestions ?? [],
          autocompleteLoading: false,
        })
      } catch {
        set({ autocompleteItems: [], autocompleteLoading: false })
      }
    }, 200)
    set({ _autocompleteTimer: timer })
  },

  selectAutocomplete: async (suggestion) => {
    set({
      query: suggestion,
      autocompleteOpen: false,
      autocompleteItems: [],
      autocompleteLoading: false,
      filters: { ...get().filters, page: 1 },
    })
    await get().executeSearch()
  },

  setAutocompleteOpen: (open) => set({ autocompleteOpen: open }),

  runResearch: async () => {
    const q = get().query.trim()
    if (!q) return
    set({ researchLoading: true, researchError: null, research: null })
    try {
      const resp = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, depth: 'standard' }),
      })
      if (!resp.ok) {
        throw new Error(`Research failed (HTTP ${resp.status})`)
      }
      const data = (await resp.json()) as ResearchReport
      set({ research: data, researchLoading: false })
    } catch (e: any) {
      set({
        researchLoading: false,
        researchError: e?.message ?? 'Deep research failed.',
      })
    }
  },

  loadSourceProfile: async (id) => {
    set({ sourceProfileLoading: true, sourceProfileError: null })
    try {
      const resp = await fetch(
        `/api/source/${encodeURIComponent(id)}`,
        { headers: { Accept: 'application/json' } },
      )
      if (!resp.ok) {
        throw new Error(`Source profile failed (HTTP ${resp.status})`)
      }
      const data = (await resp.json()) as SourceProfile
      set({ sourceProfile: data, sourceProfileLoading: false })
      return data
    } catch (e: any) {
      set({
        sourceProfileLoading: false,
        sourceProfileError: e?.message ?? 'Failed to load source profile.',
      })
      return null
    }
  },

  triggerSeedCrawl: async (urls) => {
    try {
      const resp = await fetch('/api/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(urls && urls.length > 0 ? { urls } : {}),
      })
      if (!resp.ok) {
        throw new Error(`Seed crawl failed (HTTP ${resp.status})`)
      }
      const data = (await resp.json()) as SeedCrawlResponse
      // Refresh stats after crawl.
      void get().loadStats()
      return data
    } catch (e: any) {
      // surface error to caller; the UI shows a toast.
      throw e
    }
  },

  loadStats: async () => {
    try {
      const resp = await fetch('/api/stats', { headers: { Accept: 'application/json' } })
      if (!resp.ok) return
      const data = (await resp.json()) as StatsResponse
      set({ stats: data })
    } catch {
      // silent — stats are nice-to-have
    }
  },

  // --- Lazy AI layer -------------------------------------------------------
  // Called by executeSearch() AFTER results render. Fetches the AI answer +
  // knowledge card + related questions in parallel via /api/search/ai, then
  // merges them into the existing `results` object WITHOUT re-fetching the
  // organic results. This is what makes the SERP feel fast — results appear
  // in ~1s, AI streams in after.
  loadAILayer: async () => {
    const state = get()
    if (!state.results) return
    const { query, mode, filters, results: currentResults } = state
    if (!query.trim()) return
    // Skip when AI is OFF — no point fetching.
    if (filters.aiMode === 'OFF') {
      set({ aiLayerLoading: false })
      return
    }
    set({ aiLayerLoading: true })
    try {
      const resp = await fetch('/api/search/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          mode,
          lens: state.lens,
          filters,
          results: currentResults.results.slice(0, 8),
        }),
      })
      if (!resp.ok) return
      const layer = (await resp.json()) as AILayer
      // Merge the AI layer INTO the existing results object (preserve the
      // fast-loaded organic results + instant answer + sponsored + etc).
      const fresh = get().results
      if (!fresh) return
      set({
        results: {
          ...fresh,
          aiAnswer: layer.aiAnswer,
          knowledgeCard: layer.knowledgeCard,
          relatedQuestions: layer.relatedQuestions,
        },
        aiLayerLoading: false,
      })
    } catch {
      set({ aiLayerLoading: false })
    }
  },

  // --- Saved searches (localStorage-only) ---------------------------------
  // Privacy-preserving: never sent to the server. The SavedSearch Prisma
  // model exists for future opt-in sync, but for now everything is local.

  loadSavedSearches: () => {
    if (!isBrowser()) return
    try {
      const raw = localStorage.getItem(LS_SAVED_KEY)
      if (!raw) {
        set({ savedSearches: [] })
        return
      }
      const parsed = JSON.parse(raw) as SavedSearch[]
      if (Array.isArray(parsed)) {
        set({ savedSearches: parsed })
      }
    } catch {
      set({ savedSearches: [] })
    }
  },

  saveCurrentSearch: () => {
    const { query, mode, filters, results, savedSearches } = get()
    const q = query.trim()
    if (!q) return
    // Don't save duplicates (same query + mode + freshness + sourceTypes).
    const sig = `${q}|${mode}|${filters.freshness}|${filters.sourceTypes.join(',')}`
    const dupe = savedSearches.find((s) => {
      const s2 = `${s.query}|${s.mode}|${s.filters.freshness}|${s.filters.sourceTypes.join(',')}`
      return s2 === sig
    })
    if (dupe) return
    const entry: SavedSearch = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      query: q,
      mode,
      filters: { ...filters, page: 1 },
      savedAt: new Date().toISOString(),
      resultCount: results?.pagination.totalResults,
    }
    const next = [entry, ...savedSearches].slice(0, 50) // cap at 50
    set({ savedSearches: next })
    if (isBrowser()) {
      try {
        localStorage.setItem(LS_SAVED_KEY, JSON.stringify(next))
      } catch {
        // storage full / unavailable — keep in-memory only
      }
    }
  },

  deleteSavedSearch: (id) => {
    const next = get().savedSearches.filter((s) => s.id !== id)
    set({ savedSearches: next })
    if (isBrowser()) {
      try {
        localStorage.setItem(LS_SAVED_KEY, JSON.stringify(next))
      } catch {
        // ignore
      }
    }
  },

  applySavedSearch: (id) => {
    const entry = get().savedSearches.find((s) => s.id === id)
    if (!entry) return
    set({
      query: entry.query,
      mode: entry.mode,
      filters: { ...entry.filters, page: 1 },
      showSavedSearches: false,
    })
    void get().executeSearch()
  },

  // --- Recent searches (localStorage, only when personalization is ON) ---
  loadRecentSearches: () => {
    if (!isBrowser()) return
    try {
      const raw = localStorage.getItem(LS_RECENT_KEY)
      if (!raw) {
        set({ recentSearches: [] })
        return
      }
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) set({ recentSearches: parsed })
    } catch {
      set({ recentSearches: [] })
    }
  },

  recordRecentSearch: (q) => {
    const query = q.trim()
    if (!query) return
    // Privacy: only record when personalization is ON. In private mode,
    // recent searches are never persisted.
    if (get().filters.personalization !== 'ON') return
    const next = [query, ...get().recentSearches.filter((s) => s !== query)].slice(0, 10)
    set({ recentSearches: next })
    if (isBrowser()) {
      try {
        localStorage.setItem(LS_RECENT_KEY, JSON.stringify(next))
      } catch {
        // ignore storage errors
      }
    }
  },

  clearRecentSearches: () => {
    set({ recentSearches: [] })
    if (isBrowser()) {
      try {
        localStorage.removeItem(LS_RECENT_KEY)
      } catch {
        // ignore
      }
    }
  },

  hydrateFromUrl: async () => {
    if (get()._hydrated) return
    const { query, mode, lens, filters } = parseFiltersFromUrl()
    const merged: SearchFilters = { ...DEFAULT_FILTERS, ...filters }
    // Always load the personalization preference from localStorage when the
    // URL doesn't explicitly set it — this makes the personalization toggle
    // sticky across page loads (so recent searches work on the home page
    // after the user previously enabled personalization). When the URL DOES
    // set pers=, that wins (URL is the source of truth).
    if (!filters.personalization && isBrowser()) {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
        if (saved.filters?.personalization) {
          merged.personalization = saved.filters.personalization
        }
      } catch {
        // ignore
      }
    }
    // If personalization is ON, also load any saved prefs (mode + structural
    // filters) — but URL wins when both are present.
    if (merged.personalization === 'ON' && isBrowser()) {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
        if (saved.mode && !query) {
          // No query in URL — start from saved prefs.
          ;(set as any)({ mode: saved.mode })
        }
        if (saved.filters && !filters.freshness) {
          Object.assign(merged, saved.filters)
        }
      } catch {
        // ignore
      }
    }
    set({
      query,
      mode: query ? mode : mode, // always honor URL mode if present
      lens,
      filters: merged,
      _hydrated: true,
    })
    // Persist the resolved personalization preference to localStorage so the
    // NEXT page load (which may not have pers= in the URL) can restore it.
    // This makes the personalization toggle sticky across navigations.
    get()._persistPrefs()
    // Always refresh stats + load any saved/recent searches on hydration.
    void get().loadStats()
    get().loadSavedSearches()
    get().loadRecentSearches()
    if (query.trim()) {
      await get().executeSearch()
    }
  },

  _writeUrl: () => {
    writeUrl({ query: get().query, mode: get().mode, lens: get().lens, filters: get().filters })
  },

  _persistPrefs: () => {
    // Only persist when personalization is ON — in private mode, NEVER persist.
    if (!isBrowser()) return
    const { filters, mode } = get()
    if (filters.personalization !== 'ON') {
      try {
        localStorage.removeItem(LS_KEY)
      } catch {
        // ignore
      }
      return
    }
    try {
      const payload = {
        mode,
        filters: {
          freshness: filters.freshness,
          sourceTypes: filters.sourceTypes,
          domainDiversity: filters.domainDiversity,
          aiMode: filters.aiMode,
          personalization: filters.personalization,
          safeSearch: filters.safeSearch,
          language: filters.language,
          country: filters.country,
          // page intentionally NOT persisted.
        },
      }
      localStorage.setItem(LS_KEY, JSON.stringify(payload))
    } catch {
      // ignore
    }
  },

  _loadPrefs: () => {
    if (!isBrowser()) return
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
      if (saved.mode) set({ mode: saved.mode })
      if (saved.filters) {
        const f = saved.filters
        set({
          filters: {
            ...get().filters,
            ...f,
            page: 1, // never restore page
          },
        })
      }
    } catch {
      // ignore
    }
  },
}))

// Re-export IndexStats type for the IndexStatusBar component (which uses the
// `indexStats` field from SearchResponse AND the `stats` field from this
// store — both are the same shape).
export type { IndexStats }
