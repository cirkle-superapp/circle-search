/**
 * types.ts
 * -----------------------------------------------------------------------------
 * Shared client-side type definitions for the CIRKLE frontend. These
 * mirror the shapes returned by the search-engine backend API
 * (see `src/lib/search/index.ts` + `src/lib/search/ai-search.ts`) but are
 * redefined here so client bundles never need to import the server-side
 * search library (which transitively touches Prisma + the LLM client).
 */

export type SearchMode =
  | 'BALANCED'
  | 'EXACT'
  | 'LATEST'
  | 'RESEARCH'
  | 'OFFICIAL'
  | 'ACADEMIC'
  | 'COMMUNITY'
  | 'NEWS'
  | 'IMAGES'

/**
 * Search Lenses — algorithmic perspective-shifting. Each lens re-weights
 * the ranking signals to surface a specific perspective. The standout
 * creative lens is DEVILS_ADVOCATE — it INVERTS the lexical match signal
 * so docs that don't match as strongly surface FIRST (deliberately
 * surfaces contrarian / dissenting / tangential views).
 *
 * This mirrors `SearchLens` from `src/lib/search/ranking.ts` (server-side)
 * — redefined here so client bundles never import the server ranking lib.
 */
export type SearchLens =
  | 'BALANCED'
  | 'ACADEMIC'
  | 'NEWS'
  | 'PRIMARY'
  | 'COMMUNITY'
  | 'COMMERCIAL'
  | 'DEVILS_ADVOCATE'

/**
 * Lens metadata for the UI. Mirrors LENS_METADATA in
 * `src/lib/search/ranking.ts`. The `icon` field is a lucide-react icon
 * name (lowercased, kebab-cased) — the UI maps it to the actual icon
 * component.
 */
export interface LensMeta {
  label: string
  /** lucide-react icon name (kebab-case). */
  icon: string
  /** Tailwind text color token (e.g. 'text-rose'). */
  color: string
  /** Tailwind bg color token (e.g. 'bg-rose') — used for the active pill. */
  bg: string
  /** Tailwind border/ring color token. */
  ring: string
  description: string
}

export const LENS_METADATA: Record<SearchLens, LensMeta> = {
  BALANCED: {
    label: 'Balanced',
    icon: 'scale',
    color: 'text-foreground',
    bg: 'bg-foreground/10',
    ring: 'ring-foreground/30',
    description: 'Default mode-weighted ranking. No perspective bias.',
  },
  ACADEMIC: {
    label: 'Academic',
    icon: 'graduation-cap',
    color: 'text-teal',
    bg: 'bg-teal/15',
    ring: 'ring-teal/40',
    description: 'Boosts peer-reviewed + official sources. Surfaces primary research.',
  },
  NEWS: {
    label: 'News',
    icon: 'newspaper',
    color: 'text-rose',
    bg: 'bg-rose/15',
    ring: 'ring-rose/40',
    description: 'Boosts recency + news sources. Best for current events.',
  },
  PRIMARY: {
    label: 'Primary',
    icon: 'file-text',
    color: 'text-gold',
    bg: 'bg-gold/15',
    ring: 'ring-gold/40',
    description: 'Boosts first-hand accounts + primary sources. Direct evidence.',
  },
  COMMUNITY: {
    label: 'Community',
    icon: 'users',
    color: 'text-steel',
    bg: 'bg-steel/15',
    ring: 'ring-steel/40',
    description: 'Boosts forums, discussions, Q&A sites. Lived experience.',
  },
  COMMERCIAL: {
    label: 'Commercial',
    icon: 'shopping-bag',
    color: 'text-gold',
    bg: 'bg-gold/15',
    ring: 'ring-gold/40',
    description: 'Boosts product pages + commercial sources. Buyer intent.',
  },
  DEVILS_ADVOCATE: {
    label: "Devil's Advocate",
    icon: 'flame',
    color: 'text-rose',
    bg: 'bg-rose/20',
    ring: 'ring-rose/50',
    description:
      'INVERTS the ranking to surface dissenting, contrarian, and tangential views. For controversial queries, this surfaces the perspectives the standard ranking would bury.',
  },
}

export type SourceType =
  | 'OFFICIAL'
  | 'GOVERNMENT'
  | 'ACADEMIC'
  | 'NEWS'
  | 'COMMUNITY'
  | 'COMMERCIAL'
  | 'PRIMARY'
  | 'WEB'

export type Freshness =
  | 'ANY'
  | 'HOUR'
  | 'DAY'
  | 'WEEK'
  | 'MONTH'
  | 'YEAR'
  | 'CUSTOM'

export type AiMode = 'AUTO' | 'ON' | 'OFF'

export type Personalization = 'ON' | 'OFF'

export type SafeSearch = 'ON' | 'OFF'

export interface SearchFilters {
  freshness: Freshness
  freshnessCustomStart?: string
  freshnessCustomEnd?: string
  sourceTypes: SourceType[]
  language?: string
  country?: string
  domainDiversity: 0 | 1 | 2 | 3
  aiMode: AiMode
  personalization: Personalization
  safeSearch: SafeSearch
  page: number
  pageSize: number
}

export interface SearchResult {
  id: string
  title: string
  url: string
  domain: string
  snippet: string
  sourceType: string
  publishedAt: string | null
  updatedAt: string | null
  language: string
  country: string | null
  isOriginal: boolean
  clusterId: string | null
  clusterSize: number
  whyThisResult: string[]
  relevanceScore: number
  qualityScore: number
  author: string | null
  docType: string
  ogImage: string | null
}

export interface SearchSponsored {
  id: string
  advertiser: string
  headline: string
  displayUrl: string
  targetUrl: string
  snippet: string
  whyAdReason: string
}

export interface SearchCluster {
  id: string
  primaryId: string
  size: number
  suppressedIds: string[]
}

export interface SearchPagination {
  page: number
  pageSize: number
  totalResults: number
  totalPages: number
}

export interface IndexStats {
  documents: number
  domains: number
  indexSize: number
  lastCrawl: string | null
}

export type AiSupportStatus =
  | 'DIRECTLY_SUPPORTED'
  | 'MULTI_SOURCE'
  | 'INDIRECT'
  | 'CONFLICTING'
  | 'INSUFFICIENT'

export interface AiCitation {
  id: number
  title: string
  url: string
  snippet: string
  sourceType: string
}

export interface AiClaim {
  text: string
  citations: number[]
}

export interface AiConflict {
  a: string
  b: string
  reason: string
}

export interface AiAnswer {
  answer: string
  claims: AiClaim[]
  citations: AiCitation[]
  supportStatus: AiSupportStatus
  conflicts?: AiConflict[]
  generatedAt: string
}

// --- Knowledge Graph entity card (§7.3, §23) -------------------------------

export interface KnowledgeFact {
  label: string
  value: string
  citations: number[]
}

export interface KnowledgeCard {
  entityName: string
  entityType: string
  description: string
  facts: KnowledgeFact[]
  citations: AiCitation[]
  confidenceClass: 'HIGH' | 'MEDIUM' | 'LOW'
  generatedAt: string
}

// --- Instant answer (real-time tools: weather / time / math) -------------

export type InstantAnswerKind = 'weather' | 'time' | 'math' | 'convert' | 'currency'

export interface InstantAnswer {
  kind: InstantAnswerKind
  title: string
  summary: string
  facts: { label: string; value: string }[]
  source: string
  sourceUrl?: string
  fetchedAt: string
}

// --- Live web fallback (supplementary results when index is empty) --------

export interface LiveWebResult {
  title: string
  url: string
  snippet: string
  domain: string
  sourceType: string
}

/**
 * Structured query-introspection object — emitted by the server alongside
 * the `interpretedQuery` string. Used by the QueryDna card to show the
 * user's query as tokens / intent / entities / languages / countries.
 *
 * Optional: the server may omit it (older builds). The QueryDna card
 * gracefully degrades by deriving tokens from the raw query string.
 */
export interface ParsedQuerySummary {
  tokens: string[]
  phrases: string[]
  exclusions: string[]
  intent: string
  entities: { text: string; type: string }[]
  languages: string[]
  countries: string[]
}

export interface SearchResponse {
  query: string
  interpretedQuery: string
  /** Structured query introspection (optional — older server builds omit). */
  parsed?: ParsedQuerySummary
  instantAnswer: InstantAnswer | null
  liveWebResults: LiveWebResult[]
  aiAnswer: AiAnswer | null
  knowledgeCard: KnowledgeCard | null
  sponsored: SearchSponsored[]
  results: SearchResult[]
  clusters: SearchCluster[]
  relatedQuestions: string[]
  didYouMean: string | null
  pagination: SearchPagination
  personalized: boolean
  personalizationFactors: string[]
  indexStats: IndexStats
}

// --- Lazy AI layer (fetched after results render) -------------------------

export interface AILayer {
  aiAnswer: AiAnswer | null
  knowledgeCard: KnowledgeCard | null
  relatedQuestions: string[]
}

// --- Deep Research report shape -------------------------------------------

export interface ResearchStep {
  step: string
  status: string // 'pending' | 'in_progress' | 'done' | 'failed'
}

export interface ResearchEvidence {
  claim: string
  sources: number[]
  support: string
}

export interface ResearchSource {
  id: number
  title: string
  url: string
  snippet: string
  sourceType: string
}

export interface ResearchReport {
  subQueries: string[]
  steps: ResearchStep[]
  executiveSummary: string
  keyFindings: string[]
  evidence: ResearchEvidence[]
  contradictions: AiConflict[]
  limitations: string
  sources: ResearchSource[]
  generatedAt: string
}

// --- Source profile (GET /api/source/[id]) --------------------------------

export interface SourceProfile {
  id: string
  publisher: string | null
  sourceType: string
  country: string | null
  language: string
  firstIndexed: string
  lastCrawled: string
  lastUpdate: string | null
  isOriginal: boolean
  contentCategories: string[]
  relatedPrimarySources: {
    id: string
    title: string
    url: string
    sourceType: string
    crawledAt: string
  }[]
  documentsInIndex: number
  domain: string
}

// --- Seed crawl response (POST /api/seed) --------------------------------

export interface SeedCrawlResponse {
  queued: number
  crawled: number
  indexed: number
  errors: string[]
}

// --- Suggest response (GET /api/suggest?q=...) ---------------------------

export interface SuggestResponse {
  suggestions: string[]
}

// --- Stats response (GET /api/stats) -------------------------------------

export interface StatsResponse {
  documents: number
  domains: number
  queueDepth: number
  lastCrawl: string | null
  crawlErrors: number
  indexSize: number
}
