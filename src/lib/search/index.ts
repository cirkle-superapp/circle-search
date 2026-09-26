/**
 * index.ts
 * -----------------------------------------------------------------------------
 * Orchestrator for the search engine. Re-exports the public API + types
 * and provides:
 *
 *   - indexDocumentFromCrawl(rawUrl, rawHtml, finalUrl, contentType)
 *       The full document processing pipeline:
 *         canonicalize → parseHtml → classifySource → quality+spam+dedup →
 *         upsert Document → indexDocument (postings) → extract links →
 *         upsert Link rows. Marks CrawlQueue row done.
 *
 *   - search(query, mode, filters, opts)
 *       The main entry. Implements §3 candidate retrieval → ranking →
 *       diversity → assembly. Returns the full SearchResponse shape from
 *       the API contract in worklog.md.
 *
 *   - getSource(id), getStats()
 *       Helpers for /api/source/[id] and /api/stats endpoints.
 *
 * All LLM traffic flows through the unified LLM client at `@/lib/llm`
 * (Groq → Gemini → OpenRouter fallback chain). Server-side only.
 * -----------------------------------------------------------------------------
 */

import { db } from '@/lib/db'

// --- Public re-exports ----------------------------------------------------
export type { ParsedQuery, QueryIntent, SourceType } from './query-understanding'
export { parseQuery, expandQuery } from './query-understanding'
export type { SearchMode, SearchFilters, RankInput, RankedResult } from './ranking'
export { rankCandidates } from './ranking'
export { tokenize, normalize, stem, contentHash, simhash } from './text-processor'
export { fetchUrl, checkRobots, extractSitemapUrls } from './crawler'
export { canonicalizeUrl, extractDomain, registeredDomain } from './canonical'
export { parseHtml } from './html-parser'
export type { ParsedDoc, ParsedHeading, ParsedLink } from './html-parser'
export { classifySource, classifyUrl } from './source-classifier'
export { assessQuality } from './quality-engine'
export type { QualitySignals, QualityInput } from './quality-engine'
export { detectSpam } from './spam-engine'
export type { SpamVerdict, SpamInput } from './spam-engine'
export { findDuplicate, hammingDistance64 } from './dedup'
export type { DedupResult } from './dedup'
export { indexDocument, queryIndex, invalidateIndexCache, getAllDocsMap, getDocCount, makeSnippet, fetchContentForSnippets, reindexAll } from './indexer'
export type { QueryHit, Posting } from './indexer'
export { applyDiversity } from './diversity'
export type { DiversityResult, DiversityCluster } from './diversity'
export { generateAISummary, generateResearchReport, summarizePage } from './ai-search'
export type { AISearchResult, ResearchReport, AICitation, AIClaim, AIConflict, KnowledgeCard, PageSummary } from './ai-search'
export { SEED_URLS, seedCrawl } from './seed'
export { LARGE_SEED_URLS, RSS_FEED_URLS } from './large-seed'
export { suggest, getTrendingSearches } from './suggest'
export { recordSearch, recordAILayer, getMetrics } from './metrics'

import { canonicalizeUrl, extractDomain, registeredDomain } from './canonical'
import { parseHtml, type ParsedDoc } from './html-parser'
import { classifyUrl } from './source-classifier'
import { assessQuality } from './quality-engine'
import { detectSpam } from './spam-engine'
import { findDuplicate } from './dedup'
import { indexDocument, queryIndex, getAllDocsMap, makeSnippet, fetchContentForSnippets, invalidateIndexCache } from './indexer'
import { rankCandidates, type SearchMode, type SearchFilters, type SearchLens } from './ranking'
import { applyDiversity } from './diversity'
import { parseQuery, expandQuery, type ParsedQuery } from './query-understanding'
import { tokenize, removeStopwords, stem, contentHash, simhash, normalize } from './text-processor'
import { generateAISummary, generateKnowledgeCard, type AISearchResult, type KnowledgeCard } from './ai-search'
import { runTool, runLiveWebSearch, shouldLiveWebFallback, type InstantAnswer, type LiveWebResult } from './tools'
import { recordSearch } from './metrics'
import { LARGE_SEED_URLS } from './large-seed'

// --- LRU search-result cache ----------------------------------------------
// Caches the full SearchResponse for repeated queries so the second+ search
// for the same query+mode+filters returns in <5ms instead of re-running BM25.
// Capped at 200 entries, TTL 5 minutes (so fresh crawls eventually show up).
const SEARCH_CACHE_MAX = 200
const SEARCH_CACHE_TTL_MS = 5 * 60_000
interface CacheEntry { data: any; expiresAt: number }
const _searchCache = new Map<string, CacheEntry>()

function searchCacheKey(query: string, mode: string, filters: any, lens: string = 'BALANCED'): string {
  return `${query.trim().toLowerCase()}|${mode}|${lens}|${filters.freshness ?? 'ANY'}|${(filters.sourceTypes ?? []).join(',')}|${filters.domainDiversity ?? 2}|${filters.aiMode ?? 'AUTO'}|${filters.personalization ?? 'OFF'}|${filters.page ?? 1}`
}

function getSearchCache(key: string): any | null {
  const entry = _searchCache.get(key)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    _searchCache.delete(key)
    return null
  }
  // Move to end (LRU — most recently used stays)
  _searchCache.delete(key)
  _searchCache.set(key, entry)
  return entry.data
}

function setSearchCache(key: string, data: any): void {
  if (_searchCache.size >= SEARCH_CACHE_MAX) {
    // Evict oldest entry (first key in insertion order)
    const firstKey = _searchCache.keys().next().value
    if (firstKey) _searchCache.delete(firstKey)
  }
  _searchCache.set(key, { data, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS })
}

/** Invalidate the search cache — call after a seed crawl so fresh results show. */
export function invalidateSearchCache(): void {
  _searchCache.clear()
}

// --- Shared result types ---------------------------------------------------

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
  indexSize: number // bytes of inverted-index JSON (approximate)
  lastCrawl: string | null
}

export interface SearchResponse {
  query: string
  interpretedQuery: string
  /**
   * Structured query introspection — emitted alongside the interpretedQuery
   * string so the frontend's QueryDna card can render the user's query as
   * tokens / intent / entities / languages / countries without re-parsing.
   */
  parsed: {
    tokens: string[]
    phrases: string[]
    exclusions: string[]
    intent: string
    entities: { text: string; type: string }[]
    languages: string[]
    countries: string[]
  }
  tookMs: number // P2-1: search latency in ms
  totalFound: number // P2-1: total matching docs from index (pre-pagination)
  instantAnswer: InstantAnswer | null
  liveWebResults: LiveWebResult[]
  aiAnswer: AISearchResult | null
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

// --- Document pipeline ----------------------------------------------------

export interface IndexResult {
  docId?: string
  error?: string
}

/**
 * Index a freshly-fetched HTML document.
 *
 * Pipeline: canonicalize → parseHtml → classifySource → quality+spam+dedup →
 * upsert Document → indexDocument (postings) → extract links → upsert Link
 * rows. Marks CrawlQueue row done.
 */
export async function indexDocumentFromCrawl(
  rawUrl: string,
  rawHtml: string,
  finalUrl: string,
  _contentType: string
): Promise<IndexResult> {
  if (!rawHtml) return { error: 'empty content' }

  const canonUrl = canonicalizeUrl(finalUrl || rawUrl)
  if (!canonUrl) return { error: 'invalid URL' }

  const domain = extractDomain(canonUrl) ?? ''
  const registeredDom = registeredDomain(canonUrl) ?? domain

  const parsed: ParsedDoc = parseHtml(rawHtml, canonUrl)
  if (!parsed.title && parsed.wordCount < 50) {
    return { error: 'low signal — no title and very little content' }
  }

  // Source classification
  const classification = classifyUrl(canonUrl, parsed)
  const sourceType = classification.sourceType

  // Content hashes
  const textForHash = (parsed.bodyText || parsed.title || canonUrl)
  const chash = contentHash(textForHash)
  const shash = simhash(textForHash)

  // Quality + spam
  const qSignals = assessQuality({
    contentText: parsed.bodyText,
    wordCount: parsed.wordCount,
    headings: parsed.headings,
    metaDescription: parsed.metaDescription,
    title: parsed.title,
    crawledAt: new Date(),
    publishedAt: parsed.publishedAt ? new Date(parsed.publishedAt) : null,
    updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : null,
    author: parsed.author,
    publisher: parsed.publisher,
    linkCount: parsed.links.length,
    domain: registeredDom,
  })

  const spam = detectSpam({
    contentText: parsed.bodyText,
    title: parsed.title,
    metaKeywords: parsed.metaKeywords,
    links: parsed.links,
    domain: registeredDom,
    url: canonUrl,
  })

  // Dedup
  const dedup = await findDuplicate(chash, shash, parsed.title, registeredDom)
  const isOriginal = !dedup.isExactDuplicate && !dedup.isNearDuplicate
  const clusterId = dedup.clusterKey

  // Snippet — prefer meta description, else first ~160 chars of body
  let snippet = parsed.metaDescription ?? ''
  if (!snippet && parsed.bodyText) {
    snippet = parsed.bodyText.slice(0, 200)
  }

  const headingsJson = JSON.stringify(parsed.headings.slice(0, 50))

  // Upsert Document (by URL)
  let doc
  try {
    doc = await db.document.upsert({
      where: { url: canonUrl },
      create: {
        url: canonUrl,
        canonicalUrl: parsed.canonicalUrl,
        domain,
        title: parsed.title || canonUrl,
        snippet,
        contentText: parsed.bodyText,
        headings: headingsJson,
        links: '[]', // set below
        metaDescription: parsed.metaDescription,
        metaKeywords: parsed.metaKeywords,
        ogType: parsed.ogType,
        ogImage: parsed.ogImage,
        sourceType,
        language: parsed.language || 'en',
        country: classification.country ?? null,
        author: classification.author ?? parsed.author,
        publisher: classification.publisher ?? domain,
        publishedAt: parsed.publishedAt ? new Date(parsed.publishedAt) : null,
        updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : null,
        crawledAt: new Date(),
        contentHash: chash,
        simhash: shash,
        clusterId,
        qualityScore: qSignals.qualityScore,
        spamScore: spam.spamScore,
        isOriginal,
        wordCount: parsed.wordCount,
      },
      update: {
        canonicalUrl: parsed.canonicalUrl,
        title: parsed.title || canonUrl,
        snippet,
        contentText: parsed.bodyText,
        headings: headingsJson,
        metaDescription: parsed.metaDescription,
        metaKeywords: parsed.metaKeywords,
        ogType: parsed.ogType,
        ogImage: parsed.ogImage,
        sourceType,
        country: classification.country ?? null,
        author: classification.author ?? parsed.author,
        publisher: classification.publisher ?? domain,
        publishedAt: parsed.publishedAt ? new Date(parsed.publishedAt) : null,
        updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : null,
        crawledAt: new Date(),
        contentHash: chash,
        simhash: shash,
        clusterId,
        qualityScore: qSignals.qualityScore,
        spamScore: spam.spamScore,
        isOriginal,
        wordCount: parsed.wordCount,
      },
      select: { id: true },
    })
  } catch (e: any) {
    return { error: 'db upsert failed: ' + (e?.message ?? String(e)) }
  }

  // Index postings
  try {
    await indexDocument(doc.id, parsed.bodyText, parsed.title, parsed.headings)
    invalidateIndexCache()
  } catch (e: any) {
    return { error: 'indexing failed: ' + (e?.message ?? String(e)) }
  }

  // Extract links → upsert Link rows (in batches)
  try {
    const links = parsed.links.slice(0, 200)
    if (links.length > 0) {
      // Delete old links for this source URL then create new ones
      await db.link.deleteMany({ where: { sourceUrl: canonUrl } })
      await db.link.createMany({
        data: links.map((l) => ({
          sourceUrl: canonUrl,
          targetUrl: l.url,
          anchorText: (l.anchor || '').slice(0, 300),
          relationship:
            l.rel && /nofollow/i.test(l.rel) ? 'nofollow' :
            l.rel && /sponsored/i.test(l.rel) ? 'sponsor' :
            l.rel && /ugc/i.test(l.rel) ? 'ugc' : 'follow',
        })),
      })
    }
  } catch {
    // non-fatal — we already have the doc indexed
  }

  // Mark CrawlQueue done if a row exists
  try {
    await db.crawlQueue.updateMany({
      where: { OR: [{ url: canonUrl }, { url: rawUrl }] },
      data: { status: 'done', httpStatus: 200, contentHash: chash, lastCrawledAt: new Date() },
    })
  } catch {
    // ignore
  }

  return { docId: doc.id }
}

// --- Search ---------------------------------------------------------------

/**
 * Levenshtein distance — used for "Did you mean?" suggestions.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const prev = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    let prevSub = prev[0]
    prev[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,         // deletion
        prev[j - 1] + 1,     // insertion
        prevSub + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      )
      prevSub = tmp
    }
  }
  return prev[n]
}

interface DocRow {
  id: string
  url: string
  domain: string
  title: string
  sourceType: string
  language: string
  country: string | null
  publishedAt: Date | null
  updatedAt: Date | null
  crawledAt: Date
  qualityScore: number
  spamScore: number
  isOriginal: boolean
  clusterId: string | null
  wordCount: number
  author: string | null
  publisher: string | null
  indexTerms: string | null
  snippet: string
}

function passesFreshnessFilter(doc: DocRow, filters: SearchFilters, parsed: ParsedQuery): boolean {
  // Wire the after:/before: operators from the parsed query.
  if (parsed.dateRange) {
    const ref = doc.updatedAt ?? doc.publishedAt
    if (!ref) return false // date range specified but doc has no date → exclude
    const t = new Date(ref).getTime()
    if (parsed.dateRange.start && t < new Date(parsed.dateRange.start).getTime()) return false
    if (parsed.dateRange.end && t > new Date(parsed.dateRange.end).getTime()) return false
  }
  if (filters.freshness === 'ANY') return true
  const ref = doc.updatedAt ?? doc.publishedAt
  // Don't filter out undated content — it might be evergreen/recent.
  // Only filter docs that HAVE a date but are older than the threshold.
  if (!ref) return true
  const ms = Date.now() - new Date(ref).getTime()
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  switch (filters.freshness) {
    case 'HOUR': return ms <= HOUR
    case 'DAY': return ms <= DAY
    case 'WEEK': return ms <= 7 * DAY
    case 'MONTH': return ms <= 30 * DAY
    case 'YEAR': return ms <= 365 * DAY
    case 'CUSTOM': {
      const start = filters.freshnessCustomStart ? new Date(filters.freshnessCustomStart).getTime() : -Infinity
      const end = filters.freshnessCustomEnd ? new Date(filters.freshnessCustomEnd).getTime() : Infinity
      const t = new Date(ref).getTime()
      return t >= start && t <= end
    }
    default: return true
  }
}

function passesLanguageFilter(doc: DocRow, filters: SearchFilters, parsed: ParsedQuery): boolean {
  // Wire the lang: operator from the parsed query.
  const lang = filters.language || parsed.languages?.[0]
  if (!lang) return true
  return (doc.language ?? '').toLowerCase().startsWith(lang.toLowerCase())
}

function passesCountryFilter(doc: DocRow, filters: SearchFilters, parsed: ParsedQuery): boolean {
  // Wire the region: operator from the parsed query.
  const country = filters.country || parsed.countries?.[0]
  if (!country) return true
  return (doc.country ?? '').toLowerCase() === country.toLowerCase()
}

function passesFileTypeFilter(doc: DocRow, parsed: ParsedQuery): boolean {
  // Wire the filetype: operator from the parsed query.
  if (!parsed.filetype) return true
  const ext = parsed.filetype.toLowerCase()
  if (ext === 'pdf') return doc.url.toLowerCase().endsWith('.pdf')
  if (ext === 'doc' || ext === 'docx') return doc.url.toLowerCase().match(/\.docx?$/)
  return true
}

function passesSafeSearchFilter(doc: DocRow, filters: SearchFilters): boolean {
  // SafeSearch ON: filter out docs with high spam scores (adult content / spam).
  if (filters.safeSearch !== 'ON') return true
  return (doc.spamScore ?? 0) < 0.5
}

function passesSourceTypeFilter(doc: DocRow, mode: SearchMode, filters: SearchFilters, parsed: ParsedQuery): boolean {
  const modeTypes: SearchMode[] = ['OFFICIAL', 'ACADEMIC', 'COMMUNITY', 'NEWS']
  // Wire the official:/academic:/etc source-preference operators.
  if (parsed.sourcePreference && modeTypes.includes(parsed.sourcePreference as SearchMode)) {
    if (doc.sourceType !== parsed.sourcePreference) return false
  }
  if (modeTypes.includes(mode)) {
    if (doc.sourceType !== mode) return false
  }
  if (mode === 'IMAGES') {
    if (!doc.ogImage) return false
  }
  if (filters.sourceTypes && filters.sourceTypes.length > 0) {
    if (!filters.sourceTypes.includes(doc.sourceType)) return false
  }
  return true
}

function passesSiteFilter(doc: DocRow, parsed: ParsedQuery): boolean {
  if (!parsed.site) return true
  return doc.domain.toLowerCase().endsWith(parsed.site.toLowerCase()) ||
    doc.domain.toLowerCase().includes(parsed.site.toLowerCase())
}

function docTypeFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const m = u.pathname.toLowerCase().match(/\.(pdf|docx?|pptx?|xlsx?|rtf|odt|tex)$/i)
    if (m) return m[1].toUpperCase()
    if (u.pathname.toLowerCase().endsWith('.pdf')) return 'PDF'
  } catch {
    // ignore
  }
  return ''
}

/**
 * The main search entry. Returns the full SearchResponse.
 *
 * opts.personalization — when 'OFF', no user-specific signals are used
 * (only language/region from the filters, not from history).
 */
export async function search(
  query: string,
  mode: SearchMode,
  filters: SearchFilters,
  opts: {
    sessionId?: string
    personalization: 'ON' | 'OFF'
    /** Creative lens — algorithmic perspective shift. Default 'BALANCED'. */
    lens?: SearchLens
  } = { personalization: 'OFF' }
): Promise<SearchResponse> {
  const parsed = parseQuery(query)
  const lens = opts.lens ?? 'BALANCED'

  // --- LRU cache check: if we've seen this exact query+mode+filters
  // recently, return the cached response in <1ms. This makes repeated
  // searches (autocomplete, back-button, pagination) instant. ---
  const _searchStart = Date.now()
  const cacheKey = searchCacheKey(query, mode, filters, lens)

  // Tier 1: LRU in-memory cache (< 1ms, lost on restart)
  const cached = getSearchCache(cacheKey)
  if (cached) {
    void recordSearch({ query, mode, latencyMs: Date.now() - _searchStart, resultCount: cached.results?.length ?? 0, cacheHit: true, toolUsed: cached.instantAnswer?.kind ?? null })
    return {
      ...cached,
      query,
      tookMs: Date.now() - _searchStart, // P2-1: report real latency for cache hits too
      totalFound: cached.pagination?.totalResults ?? cached.results?.length ?? 0,
    }
  }

  // NOTE: Neon persistent cache READ is intentionally NOT in the hot path.
  // In the sandbox, the Neon HTTP connection times out (~2s), adding
  // unacceptable latency. The Neon WRITE is fire-and-forget (after search
  // completes). In production (Vercel), where Neon is fast, a separate
  // edge-middleware can check the Neon cache before hitting the search API.

  // --- Fast path: if a real-time tool matches (weather / time / math),
  // run it immediately + skip the index retrieval entirely. This makes
  // "weather in Dubai" or "2+2" answer in ~1-3s instead of 15s. ---
  const toolResult = await runTool(query)
  if (toolResult.instantAnswer) {
    // Tool matched — return the instant answer + empty results immediately.
    const indexStats: IndexStats = {
      documents: 0,
      domains: 0,
      indexSize: 0,
      lastCrawl: null,
    }
    try {
      const fastStats = getStatsFast()
      if (fastStats) Object.assign(indexStats, fastStats)
    } catch { /* ignore */ }

    // P1-2: record tool-path metrics BEFORE the return — the previous code
    // had an unreachable recordSearch + duplicate return block here.
    void recordSearch({
      query,
      mode,
      latencyMs: Date.now() - _searchStart,
      resultCount: 0,
      cacheHit: false,
      toolUsed: toolResult.instantAnswer.kind,
    })

    return {
      query,
      interpretedQuery: parsed.tokens.join(' '),
      parsed: {
        tokens: parsed.tokens,
        phrases: parsed.phrases,
        exclusions: parsed.exclusions,
        intent: parsed.intent,
        entities: parsed.entities,
        languages: parsed.languages,
        countries: parsed.countries,
      },
      tookMs: Date.now() - _searchStart, // P2-1
      totalFound: 0,                      // P2-1: tool path — no index hits
      instantAnswer: toolResult.instantAnswer,
      liveWebResults: [],
      aiAnswer: null,
      knowledgeCard: null,
      sponsored: [],
      results: [],
      clusters: [],
      relatedQuestions: [],
      didYouMean: null,
      pagination: { page: 1, pageSize: 10, totalResults: 0, totalPages: 1 },
      personalized: false,
      personalizationFactors: [],
      indexStats,
    }
  }

  // Build query tokens (with phrase support if exact mode or phrases present)
  const phraseRequested = mode === 'EXACT' || parsed.phrases.length > 0
  const queryTokens = removeStopwords(tokenize(
    (parsed.tokens.join(' ') + ' ' + parsed.phrases.join(' ')).trim()
  ))

  // Load the index map
  const allDocsMap = await getAllDocsMap()
  const allDocs: DocRow[] = Array.from(allDocsMap.values()) as DocRow[]

  // Pre-filter (apply all filters at retrieval time for efficiency)
  const filteredDocs: DocRow[] = []
  for (const d of allDocs) {
    if (!passesFreshnessFilter(d, filters, parsed)) continue
    if (!passesLanguageFilter(d, filters, parsed)) continue
    if (!passesCountryFilter(d, filters, parsed)) continue
    if (!passesSourceTypeFilter(d, mode, filters, parsed)) continue
    if (!passesSiteFilter(d, parsed)) continue
    if (!passesFileTypeFilter(d, parsed)) continue
    if (!passesSafeSearchFilter(d, filters)) continue
    filteredDocs.push(d)
  }

  // Query the indexer's TF-IDF engine over the WHOLE index, then intersect
  // with filtered docs (so we get the proper ranking signal).
  const hits = await queryIndex(queryTokens, { phrase: phraseRequested })
  const hitByDocId = new Map(hits.map((h) => [h.docId, h]))

  // --- Semantic query expansion (§5, §2) ---
  // If the initial BM25 query returned < 10 results AND AI is enabled,
  // expand the query with LLM-generated synonyms + run a second BM25.
  // This finds docs that use different words for the same concept —
  // "semantic" search without embeddings.
  if (hits.length < 10 && filters.aiMode !== 'OFF') {
    try {
      const expanded = await expandQuery(parsed)
      if (expanded.synonyms && expanded.synonyms.length > 0) {
        // Add synonyms to the query tokens (stemmed for index matching).
        const synonymTokens = expanded.synonyms
          .flatMap((s: string) => tokenize(s))
          .map((t: string) => stem(t))
          .filter(Boolean)
        const expandedTokens = [...new Set([...queryTokens, ...synonymTokens])]
        if (expandedTokens.length > queryTokens.length) {
          const expandedHits = await queryIndex(expandedTokens, { phrase: false })
          // Merge: add only NEW hits (docs not already in hitByDocId).
          for (const h of expandedHits) {
            if (!hitByDocId.has(h.docId)) {
              hitByDocId.set(h.docId, h)
            }
          }
        }
      }
    } catch {
      // expandQuery failure is non-fatal — just use the original hits.
    }
  }

  // Build candidate list: only docs that pass filters AND have hits.
  // (If query produced no hits, we fall back to "did you mean" later.)
  const candidates = filteredDocs
    .map((d) => {
      const h = hitByDocId.get(d.id)
      if (!h) return null
      return { doc: d, hit: h }
    })
    .filter((x): x is { doc: DocRow; hit: typeof hits[number] } => x !== null)

  // --- Semantic search boost (out-of-box idea) ---
  // Compute the query embedding + look up the top-N most similar docs by
  // cosine similarity. Any doc that appears in BOTH the BM25 candidates AND
  // the semantic top-N gets a relevance boost. This catches the case where
  // BM25 misses a doc because the query uses different wording (e.g. the
  // query is "iphone" but the doc says "Apple smartphone" — semantically
  // close, lexically different).
  const semanticBoostByDocId = new Map<string, number>()
  try {
    const { semanticSearch } = await import('./indexer')
    const semanticHits = await semanticSearch(query, { limit: 30 })
    for (const sh of semanticHits) {
      semanticBoostByDocId.set(sh.docId, sh.semanticScore)
    }
  } catch {
    // semanticSearch unavailable — non-critical, BM25-only ranking proceeds.
  }

  // Build the dbDocs map expected by rankCandidates
  const dbDocsForRank = new Map<string, any>()
  for (const c of candidates) {
    dbDocsForRank.set(c.doc.id, c.doc)
  }

  const rankedInputs = candidates.map((c) => ({
    docId: c.doc.id,
    tfidf: c.hit.tfidf,
    matchedTerms: c.hit.matchedTerms,
    // Out-of-box: semantic boost from cosine similarity (0 if no embedding).
    semanticBoost: semanticBoostByDocId.get(c.doc.id) ?? 0,
  }))

  // RESEARCH mode: enlarge candidate pool — already limited by queryIndex
  // to 200; nothing more to do here.

  // Fetch the link-graph authority map (§7.4) — cached, stale-while-revalidate.
  // This gives pages with more inbound links a slight ranking boost.
  const { getAuthorityMap } = await import('./authority')
  const authorityMap = await getAuthorityMap().catch(() => new Map<string, number>())

  const ranked = await rankCandidates(
    rankedInputs,
    query,
    mode,
    filters,
    parsed,
    dbDocsForRank as any,
    { authorityMap, lens }
  )

  // Diversity
  const maxPerDomain = filters.domainDiversity === 0 ? 0 : filters.domainDiversity
  const rankedDocIds = ranked.map((r) => r.docId)
  const divResult = applyDiversity(rankedDocIds, dbDocsForRank as any, maxPerDomain)

  // Build the kept set (for the page slice)
  const keptIds = new Set(divResult.kept)
  const finalRanked = ranked.filter((r) => keptIds.has(r.docId))

  // Pagination
  const pageSize = Math.max(1, Math.min(50, filters.pageSize || 10))
  const page = Math.max(1, filters.page || 1)
  const startIdx = (page - 1) * pageSize
  const endIdx = startIdx + pageSize
  const pageRanked = finalRanked.slice(startIdx, endIdx)

  // Fetch contentText for ONLY the top-N results (not the whole index) —
  // this keeps the cold-cache search fast (~1s instead of 15s for loading
  // all contentText from Turso). The contentText is used for snippet
  // generation so query terms actually appear in the snippets.
  const topDocIds = pageRanked.map((r) => r.docId)
  const contentMap = await fetchContentForSnippets(topDocIds)

  // Build result objects
  const results: SearchResult[] = pageRanked.map((r) => {
    const doc = dbDocsForRank.get(r.docId) as DocRow
    const clusterSize = (divResult.clusters.find((c) => c.primaryId === r.docId)?.size) ?? 1
    return {
      id: doc.id,
      title: doc.title,
      url: doc.url,
      domain: doc.domain,
      snippet: makeSnippet(doc as any, queryTokens, contentMap.get(doc.id)) || doc.snippet,
      sourceType: doc.sourceType,
      publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
      updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
      language: doc.language,
      country: doc.country,
      isOriginal: doc.isOriginal,
      clusterId: doc.clusterId,
      clusterSize,
      whyThisResult: r.whySignals,
      relevanceScore: Math.round(r.relevanceScore * 1000) / 1000,
      qualityScore: Math.round(doc.qualityScore * 1000) / 1000,
      author: doc.author,
      docType: docTypeFromUrl(doc.url),
      ogImage: doc.ogImage ?? null,
    }
  })

  // Clusters (convert to public shape)
  const clusters: SearchCluster[] = divResult.clusters.map((c) => ({
    id: c.id,
    primaryId: c.primaryId,
    size: c.size,
    suppressedIds: c.suppressedIds,
  }))

  // Sponsored ads — match query keywords against SponsoredAd.keywords
  const sponsored: SearchSponsored[] = []
  try {
    const allAds = await db.sponsoredAd.findMany({ where: { active: true } })
    const queryTokensLower = new Set(queryTokens.map((t) => t.toLowerCase()))
    for (const ad of allAds) {
      let keywords: string[] = []
      try {
        keywords = JSON.parse(ad.keywords) as string[]
      } catch {
        keywords = []
      }
      const matched = keywords.some((k) =>
        queryTokensLower.has(k.toLowerCase()) ||
        query.toLowerCase().includes(k.toLowerCase())
      )
      if (matched) {
        sponsored.push({
          id: ad.id,
          advertiser: ad.advertiser,
          headline: ad.headline,
          displayUrl: ad.displayUrl,
          targetUrl: ad.targetUrl,
          snippet: ad.snippet,
          whyAdReason: ad.whyAdReason,
        })
      }
    }
  } catch {
    // ignore ad fetch errors
  }

  // --- Instant answer already handled at the top of search() (fast path).
  // If we reach here, no tool matched, so instantAnswer is null.

  // --- AI layer is now LAZY — fetched separately via /api/search/ai -------
  // The main search() returns results + instant answer + sponsored + clusters
  // immediately. The AI summary, knowledge card, and related questions are
  // slow (multiple LLM calls, ~15s) — they're fetched by the frontend AFTER
  // results render, so the user sees results in ~1s and AI streams in after.
  const aiAnswer: AISearchResult | null = null
  const knowledgeCard: KnowledgeCard | null = null
  const relatedQuestions: string[] = []

  // Did you mean? — only suggest a correction when we have NO results AND
  // a candidate is genuinely close to the query (token overlap OR very low
  // Levenshtein distance). The previous threshold (dist <= query length)
  // was too loose — "react hooks" suggested "hacker news" which is
  // irrelevant. New rule: only suggest if (a) ≥1 query token appears in the
  // candidate title, OR (b) Levenshtein distance < 40% of query length.
  let didYouMean: string | null = null
  if (finalRanked.length === 0 && allDocs.length > 0) {
    const target = parsed.tokens.join(' ')
    const queryTokens = new Set(parsed.tokens.map((t) => t.toLowerCase()))
    if (target.length > 2) {
      let best: string | null = null
      let bestScore = -Infinity
      // Sample 200 docs to keep it fast.
      const sample = allDocs.slice(0, 200)
      for (const d of sample) {
        const candidate = d.title.toLowerCase()
        if (!candidate || candidate.length < 3) continue
        // Token overlap — count query tokens that match (exact, prefix, OR
        // fuzzy). "reactt" → "react" (prefix). "javascrpt" → "javascript"
        // (fuzzy: dist=1, both ≥5 chars). This catches the common typo
        // families: extra char, missing char, transposed char, plural.
        const candidateTokens = candidate.split(/\s+/)
        let overlap = 0
        for (const qt of queryTokens) {
          if (qt.length < 3) continue
          for (const ct of candidateTokens) {
            if (ct === qt) { overlap++; break }
            // Prefix match: one is a prefix of the other (≥4 char prefix).
            if (qt.length >= 4 && ct.length >= 4 && (ct.startsWith(qt) || qt.startsWith(ct))) {
              overlap++
              break
            }
            // Fuzzy match: per-token Levenshtein ≤ 2 for tokens ≥ 5 chars.
            // Catches deletions ("javascrpt"→"javascript"), insertions,
            // transpositions ("recat"→"react").
            if (qt.length >= 5 && ct.length >= 5) {
              const td = levenshtein(qt, ct)
              if (td <= 2) { overlap++; break }
            }
          }
        }
        // Levenshtein distance against the full candidate (capped at 60 chars
        // to avoid quadratic blowup on very long titles). Previously we sliced
        // from the start which broke matches like "reactt" → "Quick Start – React".
        const clamped = candidate.slice(0, Math.min(candidate.length, 60))
        const dist = levenshtein(target, clamped)
        // Score: token overlap weighted heavily; Levenshtein penalizes.
        const score = overlap * 1.0 - dist * 0.05
        if (score > bestScore) {
          bestScore = score
          best = candidate
        }
      }
      // Only suggest if there's meaningful token overlap OR a very close
      // edit distance. Tuning rationale (dist weight = 0.05):
      //   "react hooks" vs "hacker news": overlap=0, dist~8, score=-0.4 → reject
      //   "reactt" vs "Quick Start – React": overlap=1 (prefix), score=0.15 → accept
      //   "nodjs" vs "docs.rs": overlap=0, dist~4, score=-0.2 → reject (borderline)
      const hasOverlap = bestScore >= 0.1 // ≥1 token overlaps (prefix counts)
      const veryClose = bestScore >= -0.1 // dist ≤ ~2 chars with no overlap
      if (best && (hasOverlap || veryClose)) {
        didYouMean = best
      }
    }
  }

  // Log query (aggregated, anonymized — frequency + a hash of normalized
  // query, no user identity)
  try {
    const normalizedQuery = normalize(query)
    if (normalizedQuery) {
      await db.queryLog.upsert({
        where: { normalized: normalizedQuery },
        create: { query, normalized: normalizedQuery, frequency: 1 },
        update: {
          frequency: { increment: 1 },
          lastUsedAt: new Date(),
        },
      })
    }
  } catch {
    // ignore — query logging is non-critical
  }

  // --- Instant answer: null here (tools were handled at the top of
  // search() as a fast path). ---
  const instantAnswer: InstantAnswer | null = null

  // --- Live web fallback (spec §69 supplementary source) ------------------
  // P1-1: trigger when index results are weak (count < 3 OR top-3 mean score
  // < 0.3 OR query coverage < 50%), not just when count === 0. This lets the
  // engine escape the small local index for celebrity/news queries where the
  // BM25 query happens to match an irrelevant doc.
  let liveWebResults: LiveWebResult[] = []
  const topThree = finalRanked.slice(0, 3)
  const topMeanScore = topThree.length > 0
    ? topThree.reduce((s, r) => s + r.relevanceScore, 0) / topThree.length
    : 0
  // P1-1 (extended): union of matched terms across top-3 — for coverage check.
  // We map back from finalRanked.docId → candidates[].hit.matchedTerms.
  const candidateByDocId = new Map(candidates.map((c) => [c.doc.id, c]))
  const topMatchedTerms: string[] = []
  for (const r of topThree) {
    const c = candidateByDocId.get(r.docId)
    if (c?.hit?.matchedTerms) {
      for (const t of c.hit.matchedTerms) {
        if (!topMatchedTerms.includes(t)) topMatchedTerms.push(t)
      }
    }
  }
  if (shouldLiveWebFallback(query, finalRanked.length, topMeanScore, topMatchedTerms)) {
    try {
      liveWebResults = await runLiveWebSearch(query)
    } catch {
      // ignore
    }
  }

  // MERGE live-web results into the main results array when:
  // 1. Index results are weak (fewer than 3, or top score < 0.35)
  // 2. Live-web results exist
  // The live-web results are prepended (shown FIRST) because they're from
  // the real web (DuckDuckGo) + are more relevant than the small local
  // index for broad topical queries. This fixes the "wrong outputs" issue
  // where users saw irrelevant index results above the correct live-web ones.
  if (liveWebResults.length > 0) {
    const weakIndex = finalRanked.length < 3 || (topMeanScore > 0 && topMeanScore < 0.35)
    if (weakIndex || finalRanked.length === 0) {
      // Convert live-web results to SearchResult format + prepend to results
      const liveAsSearchResults: SearchResult[] = liveWebResults.slice(0, 10).map((r, i) => ({
        id: `liveweb-${i}`,
        title: r.title,
        url: r.url,
        domain: r.domain,
        snippet: r.snippet,
        sourceType: r.sourceType,
        publishedAt: null,
        updatedAt: null,
        language: 'en',
        country: null,
        isOriginal: true,
        clusterId: null,
        clusterSize: 1,
        whyThisResult: ['Live web result', 'From DuckDuckGo/BrightData search'],
        relevanceScore: 0.8 - (i * 0.05), // decreasing score for ordering
        qualityScore: 0.5,
        author: null,
        docType: 'web',
        ogImage: null,
      }))
      // Prepend live-web results (they appear FIRST)
      results = [...liveAsSearchResults, ...results]
      // Update finalRanked for pagination
      finalRanked = [
        ...liveAsSearchResults.map((r, i) => ({
          docId: r.id,
          relevanceScore: r.relevanceScore,
          whySignals: r.whyThisResult,
        })),
        ...finalRanked,
      ]
    }
    // Clear liveWebResults if merged (they're now in the main results)
    if (weakIndex || finalRanked.length === 0) {
      liveWebResults = []
    }
  }

  // SearchHistory (only if personalization ON and a sessionId exists)
  const personalized = opts.personalization === 'ON' && !!opts.sessionId
  if (personalized && opts.sessionId) {
    try {
      await db.searchHistory.create({
        data: {
          query,
          mode,
          filters: JSON.stringify(filters),
          resultCount: finalRanked.length,
          sessionId: opts.sessionId,
        },
      })
    } catch {
      // ignore
    }
  }

  // Index stats
  const indexStats: IndexStats = {
    documents: allDocs.length,
    domains: new Set(allDocs.map((d) => d.domain)).size,
    indexSize: allDocs.reduce((s, d) => s + (d.indexTerms?.length ?? 0), 0),
    lastCrawl: allDocs.length > 0
      ? allDocs.reduce((m, d) => (d.crawledAt > m ? d.crawledAt : m), allDocs[0].crawledAt).toISOString()
      : null,
  }

  // Personalization factors (only language/region)
  const personalizationFactors: string[] = []
  if (filters.language) personalizationFactors.push(`Language: ${filters.language}`)
  if (filters.country) personalizationFactors.push(`Region: ${filters.country}`)
  if (filters.sourceTypes && filters.sourceTypes.length > 0) {
    personalizationFactors.push(`Source types: ${filters.sourceTypes.join(', ')}`)
  }
  if (filters.freshness !== 'ANY') {
    personalizationFactors.push(`Freshness: ${filters.freshness}`)
  }

  // Interpreted query string for display
  const interpretedQuery = parsed.tokens.join(' ') + (parsed.phrases.length ? ` (phrase: "${parsed.phrases.join('", "')}")` : '')

  const response: SearchResponse = {
    query,
    interpretedQuery,
    parsed: {
      tokens: parsed.tokens,
      phrases: parsed.phrases,
      exclusions: parsed.exclusions,
      intent: parsed.intent,
      entities: parsed.entities,
      languages: parsed.languages,
      countries: parsed.countries,
    },
    tookMs: Date.now() - _searchStart, // P2-1
    totalFound: finalRanked.length,    // P2-1: total matching docs from index (pre-pagination)
    instantAnswer,
    liveWebResults,
    aiAnswer,
    knowledgeCard,
    sponsored,
    results,
    clusters,
    relatedQuestions,
    didYouMean,
    pagination: {
      page,
      pageSize,
      totalResults: finalRanked.length,
      totalPages: Math.max(1, Math.ceil(finalRanked.length / pageSize)),
    },
    personalized,
    personalizationFactors,
    indexStats,
  }

  // Cache the response for repeated queries (LRU, 5-min TTL).
  setSearchCache(cacheKey, response)

  // Tier 2: also cache in Neon (persists across restarts, 5-min TTL).
  try {
    const { setNeonCache, recordNeonAnalytics } = await import('../neon')
    setNeonCache(cacheKey, query, mode, response, 300).catch(() => {})
    recordNeonAnalytics({
      query, mode, latencyMs: Date.now() - _searchStart,
      resultCount: response.results.length, cacheHit: false,
      toolUsed: response.instantAnswer?.kind ?? null,
    }).catch(() => {})
  } catch { /* Neon unavailable — non-critical */ }

  // Record metrics for observability (§66).
  void recordSearch({
    query,
    mode,
    latencyMs: Date.now() - _searchStart,
    resultCount: response.results.length,
    cacheHit: false,
    toolUsed: response.instantAnswer?.kind ?? null,
  })

  return response
}

// --- Lazy AI layer (fetched separately after results render) -------------
// The main search() returns results + instant answer + sponsored + clusters
// immediately (~1s). The AI summary + knowledge card + related questions
// are slow (multiple LLM calls). The frontend calls this function via the
// /api/search/ai endpoint AFTER the results render, so the user sees
// results instantly and the AI layer streams in after.

export interface AILayer {
  aiAnswer: AISearchResult | null
  knowledgeCard: KnowledgeCard | null
  relatedQuestions: string[]
}

export async function generateAILayer(
  query: string,
  mode: SearchMode,
  filters: SearchFilters,
  results: SearchResult[],
): Promise<AILayer> {
  const parsed = parseQuery(query)
  const aiEnabled =
    filters.aiMode === 'ON' ||
    (filters.aiMode === 'AUTO' &&
      ['BALANCED', 'LATEST', 'RESEARCH', 'ACADEMIC', 'NEWS', 'OFFICIAL'].includes(mode))

  if (!aiEnabled) {
    return { aiAnswer: null, knowledgeCard: null, relatedQuestions: [] }
  }

  // Run AI summary + knowledge card + related questions in parallel for speed.
  const [aiAnswer, knowledgeCard, expanded] = await Promise.all([
    results.length > 0
      ? generateAISummary(query, parsed, results.slice(0, 8).map((r) => ({
          id: r.id, title: r.title, url: r.url, snippet: r.snippet,
          sourceType: r.sourceType, domain: r.domain,
        }))).catch(() => null)
      : Promise.resolve(null),
    results.length >= 2
      ? generateKnowledgeCard(query, results.slice(0, 6).map((r) => ({
          id: r.id, title: r.title, url: r.url, snippet: r.snippet,
          sourceType: r.sourceType, domain: r.domain,
        }))).catch(() => null)
      : Promise.resolve(null),
    expandQuery(parsed).catch(() => ({ synonyms: [], relatedQuestions: [] })),
  ])

  return {
    aiAnswer,
    knowledgeCard,
    relatedQuestions: expanded?.relatedQuestions ?? [],
  }
}

// --- Source profile + stats -----------------------------------------------

export async function getSource(id: string): Promise<any | null> {
  const doc = await db.document.findUnique({ where: { id } })
  if (!doc) return null
  // Pull related primary sources by domain (5 most recent non-this docs)
  const related = await db.document.findMany({
    where: {
      domain: doc.domain,
      id: { not: doc.id },
      sourceType: { in: ['PRIMARY', 'OFFICIAL', 'GOVERNMENT'] },
    },
    orderBy: { crawledAt: 'desc' },
    take: 5,
    select: { id: true, title: true, url: true, sourceType: true, crawledAt: true },
  })
  const documentsInIndex = await db.document.count({ where: { domain: doc.domain } })
  return {
    id: doc.id,
    publisher: doc.publisher,
    sourceType: doc.sourceType,
    country: doc.country,
    language: doc.language,
    firstIndexed: doc.createdAt,
    lastCrawled: doc.crawledAt,
    lastUpdate: doc.updatedAt,
    isOriginal: doc.isOriginal,
    contentCategories: [doc.sourceType],
    relatedPrimarySources: related,
    documentsInIndex,
    domain: doc.domain,
  }
}

// --- Cached stats (Turso COUNT queries are remote + slow) -----------------
// Cache the stats response in-memory. Stats are 5 COUNT queries against the
// remote Turso DB — uncached, they take 5-45s. We use a STALE-WHILE-REVALIDATE
// pattern: return cached data immediately (even if stale), and refresh in the
// background. This means the first-ever request pays the cost, but every
// subsequent request (including from /api/search's indexStats field) is instant.
let _statsCache: { data: any; expiresAt: number; refreshing: boolean } | null = null
const STATS_TTL_MS = 60_000 // fresh for 1 min
const STATS_STALE_MS = 5 * 60_000 // serve stale for up to 5 min while refreshing

export function invalidateStatsCache() {
  _statsCache = null
}

async function refreshStats(): Promise<any> {
  const documents = await db.document.count()
  const domains = await db.document.groupBy({
    by: ['domain'],
    _count: { _all: true },
  })
  const queueDepth = await db.crawlQueue.count({ where: { status: 'pending' } })
  const crawlErrors = await db.crawlQueue.count({ where: { status: 'error' } })
  const recent = await db.document.findFirst({
    orderBy: { crawledAt: 'desc' },
    select: { crawledAt: true },
  })
  const indexSizeBytes = await db.document.aggregate({
    _sum: { wordCount: true },
  })
  return {
    documents,
    domains: domains.length,
    queueDepth,
    lastCrawl: recent?.crawledAt ?? null,
    crawlErrors,
    indexSize: indexSizeBytes._sum.wordCount ?? 0,
  }
}

export async function getStats(): Promise<any> {
  const now = Date.now()
  // Fresh cache → return immediately.
  if (_statsCache && _statsCache.expiresAt > now) {
    return _statsCache.data
  }
  // Stale cache (within STATS_STALE_MS) → return stale + refresh in background.
  if (_statsCache && _statsCache.expiresAt + STATS_STALE_MS > now) {
    if (!_statsCache.refreshing) {
      _statsCache.refreshing = true
      refreshStats()
        .then((data) => {
          _statsCache = { data, expiresAt: now + STATS_TTL_MS, refreshing: false }
        })
        .catch(() => {
          if (_statsCache) _statsCache.refreshing = false
        })
    }
    return _statsCache.data
  }
  // No cache (cold start) → block + fetch. This is the slow path that only
  // happens once per server restart.
  const data = await refreshStats()
  _statsCache = { data, expiresAt: now + STATS_TTL_MS, refreshing: false }
  return data
}

/** A fast snapshot for inclusion in search responses — never blocks. Returns
 *  cached stats, or a minimal placeholder if the cache is cold. */
export function getStatsFast(): any {
  if (_statsCache) return _statsCache.data
  return {
    documents: 0,
    domains: 0,
    queueDepth: 0,
    lastCrawl: null,
    crawlErrors: 0,
    indexSize: 0,
  }
}

// --- Pre-warm the index + stats cache on server start ---------------------
// Called once on server startup to load the index + stats into memory so
// the FIRST search is fast (no cold-cache penalty). This runs in the
// background — the server starts immediately and pre-warming happens async.
let _prewarmed = false
export async function prewarmIndex(): Promise<void> {
  if (_prewarmed) return
  _prewarmed = true
  try {
    // Load the document index into the in-memory cache.
    const { getAllDocsMap, invalidateIndexCache } = await import('./indexer')
    invalidateIndexCache()
    await getAllDocsMap()
    // Pre-warm the stats cache (stale-while-revalidate pattern).
    await getStats()
    console.log('[prewarm] index + stats cache warmed')
  } catch (e: any) {
    console.error('[prewarm] failed:', e?.message ?? e)
  }
}
