/**
 * ranking.ts
 * -----------------------------------------------------------------------------
 * Candidate ranking (§44). Takes the lexical candidates from the indexer,
 * looks up the full Document rows, applies mode-specific weights, and emits
 * a RankedResult per candidate with human-readable why-signals (§15).
 *
 * Modes (§10):
 *   BALANCED:  0.35*lex + 0.20*sem + 0.15*q + 0.10*fr + 0.10*st + 0.05*or + 0.05*intent
 *   EXACT:     0.70*lex + 0.10*fr + 0.10*q (no semantic)
 *   LATEST:    0.50*fr + 0.20*lex + 0.20*q + 0.10*st
 *   RESEARCH:  0.40*q + 0.20*ac/official boost + 0.20*lex + 0.10*or + 0.10*fr
 *   OFFICIAL/ACADEMIC/COMMUNITY/NEWS:
 *              filter to that sourceType (applied via filters), then
 *              0.40*lex + 0.30*q + 0.20*st + 0.10*fr
 *
 * Spam penalty: -spamScore. Duplicate penalty: -0.3 if !isOriginal.
 *
 * semanticBoost: a simple semantic-similarity proxy computed as cosine of
 * overlapping term-set weighted by idf. (Documented in code comment.)
 *
 * whySignals: top 3-5 of:
 *   "Matches your search terms"
 *   "Strong topical relevance"
 *   "Recent information"
 *   "Original source"
 *   "High-quality source"
 *   "Relevant supporting references"
 *   "Not substantially duplicated"
 * -----------------------------------------------------------------------------
 */

import type { ParsedQuery } from './query-understanding'

// Authority scores are passed in from the caller (computed once per search
// via getAuthorityMap()). domain → 0..1 authority.
export interface RankContext {
  authorityMap?: Map<string, number>
  /** Search lens — algorithmic perspective shift. Default 'BALANCED'. */
  lens?: SearchLens
}

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
 * Search Lenses — algorithmic perspective-shifting (creative out-of-box feature).
 *
 * A lens re-weights the ranking signals to surface a specific perspective.
 * The most creative lens is DEVILS_ADVOCATE — it INVERTS the lexical match
 * signal so docs that DON'T match the user's tokens as strongly appear
 * FIRST. This deliberately surfaces contrarian / dissenting / tangential
 * views, which is uniquely valuable for controversial queries.
 *
 *   "Steve Jobs" with DEVILS_ADVOCATE → surfaces docs that mention Apple
 *   critics, ex-employees, competitors, alternative viewpoints.
 *
 * Other lenses are weight-profile shifts (not inversions):
 *   - ACADEMIC: boosts ACADEMIC/OFFICIAL source types + high qualityScore.
 *   - NEWS: boosts recency + NEWS source type.
 *   - PRIMARY: boosts PRIMARY source type (first-hand accounts).
 *   - COMMUNITY: boosts COMMUNITY source type (forums, discussions).
 *   - COMMERCIAL: boosts COMMERCIAL source type (product pages).
 *   - BALANCED: no lens applied — standard ranking.
 */
export type SearchLens =
  | 'BALANCED'
  | 'ACADEMIC'
  | 'NEWS'
  | 'PRIMARY'
  | 'COMMUNITY'
  | 'COMMERCIAL'
  | 'DEVILS_ADVOCATE'

/** Lens metadata for the UI (icon, label, color, description). */
export const LENS_METADATA: Record<
  SearchLens,
  { label: string; icon: string; color: string; description: string }
> = {
  BALANCED: {
    label: 'Balanced',
    icon: 'scale',
    color: 'text-foreground',
    description: 'Default mode-weighted ranking. No perspective bias.',
  },
  ACADEMIC: {
    label: 'Academic',
    icon: 'graduation-cap',
    color: 'text-teal',
    description: 'Boosts peer-reviewed + official sources. Surfaces primary research.',
  },
  NEWS: {
    label: 'News',
    icon: 'newspaper',
    color: 'text-rose',
    description: 'Boosts recency + news sources. Best for current events.',
  },
  PRIMARY: {
    label: 'Primary',
    icon: 'file-text',
    color: 'text-gold',
    description: 'Boosts first-hand accounts + primary sources. Direct evidence.',
  },
  COMMUNITY: {
    label: 'Community',
    icon: 'users',
    color: 'text-steel',
    description: 'Boosts forums, discussions, Q&A sites. Lived experience.',
  },
  COMMERCIAL: {
    label: 'Commercial',
    icon: 'shopping-bag',
    color: 'text-gold',
    description: 'Boosts product pages + commercial sources. Buyer intent.',
  },
  DEVILS_ADVOCATE: {
    label: "Devil's Advocate",
    icon: 'flame',
    color: 'text-rose',
    description:
      'INVERTS the ranking to surface dissenting, contrarian, and tangential views. For controversial queries, this surfaces the perspectives the standard ranking would bury.',
  },
}

export interface SearchFilters {
  freshness: 'ANY' | 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | 'CUSTOM'
  freshnessCustomStart?: string
  freshnessCustomEnd?: string
  sourceTypes: string[]
  language?: string
  country?: string
  domainDiversity: 0 | 1 | 2 | 3
  aiMode: 'AUTO' | 'ON' | 'OFF'
  personalization: 'ON' | 'OFF'
  safeSearch: 'ON' | 'OFF'
  page: number
  pageSize: number
}

export interface RankInput {
  docId: string
  tfidf: number
  matchedTerms: string[]
  /** Optional: cosine similarity [0,1] from query embedding → doc embedding.
   *  0 when embeddings unavailable (BM25-only mode). */
  semanticBoost?: number
}

export interface RankedResult {
  docId: string
  relevanceScore: number
  whySignals: string[]
}

interface RankDocRow {
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

function daysSince(d: Date): number {
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)
}

function freshnessScore(doc: RankDocRow): number {
  const dateRef = doc.updatedAt ?? doc.publishedAt
  if (!dateRef) {
    // Fall back to crawledAt with conservative curve
    const d = daysSince(doc.crawledAt)
    if (d <= 30) return 0.5
    return 0.3
  }
  const d = daysSince(new Date(dateRef))
  if (d <= 90) return 1.0
  if (d <= 365) return 0.6
  return 0.3
}

/**
 * Semantic-boost proxy: cosine of overlapping term-set weighted by idf.
 *
 * NOTE: We do not have real embeddings. This is a defensible lexical-semantic
 * proxy: the query's idf-weighted term vector is compared with the doc's
 * idf-weighted term vector over the shared vocab. Documents whose own
 * strongest terms coincide with the query's strongest terms rank higher.
 *
 * For ranking we approximate this as max(tfidf) of the matched terms,
 * normalized, since tfidf already encodes idf weighting. We document this
 * here so a future semantic engine can replace it without breaking the
 * ranking contract.
 */
function semanticBoost(tfidf: number, matchedTerms: string[]): number {
  if (matchedTerms.length === 0) return 0
  // Approximate semantic similarity as the geometric mean of tfidf and the
  // fraction of query terms matched.
  const matchedRatio = Math.min(1, matchedTerms.length / 6) // saturate at 6 terms
  return tfidf * (0.5 + 0.5 * matchedRatio)
}

function intentMatch(parsed: ParsedQuery, doc: RankDocRow): number {
  // Best-effort intent scoring:
  //   - For "news" intent, NEWS sourceType gets +1.
  //   - For "academic" intent, ACADEMIC/OFFICIAL gets +1.
  //   - For "official" / "government" intent, those types get +1.
  //   - For "commercial" intent, COMMERCIAL gets +1.
  // Otherwise 0.5.
  const i = parsed.intent
  const st = doc.sourceType
  if (i === 'news' && st === 'NEWS') return 1.0
  if (i === 'academic' && (st === 'ACADEMIC' || st === 'OFFICIAL' || st === 'GOVERNMENT')) return 1.0
  if (i === 'research' && (st === 'ACADEMIC' || st === 'OFFICIAL' || st === 'GOVERNMENT')) return 1.0
  if (i === 'commercial' && st === 'COMMERCIAL') return 1.0
  if (i === 'document' && doc.url.match(/\.(pdf|docx?|pptx?)($|\?)/i)) return 1.0
  if (i === 'navigational') {
    // For nav intent, exact-domain match is best
    const dom = doc.domain.toLowerCase()
    if (parsed.tokens.some((t) => dom.includes(t))) return 1.0
  }
  return 0.5
}

function sourceTypeMatch(parsed: ParsedQuery, doc: RankDocRow): number {
  if (parsed.sourcePreference) {
    if (doc.sourceType === parsed.sourcePreference) return 1.0
    return 0.0
  }
  return 0.5
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Build the human-readable "Why this result?" signals (§15).
 * Returns the top applicable 3-5 signals.
 */
/** Generate why-signals including the authority signal. */
function buildWhySignals(
  doc: RankDocRow,
  tfidf: number,
  matchedTerms: string[],
  auth: number,
): string[] {
  const signals: string[] = []
  if (matchedTerms.length > 0) signals.push('Matches your search terms')
  if (tfidf > 0.15) signals.push('Strong topical relevance')
  const fr = freshnessScore(doc)
  if (fr > 0.7) signals.push('Recent information')
  if (doc.isOriginal) signals.push('Original source')
  if (doc.qualityScore > 0.6) signals.push('High-quality source')
  if (
    doc.sourceType === 'ACADEMIC' ||
    doc.sourceType === 'OFFICIAL' ||
    doc.sourceType === 'GOVERNMENT' ||
    doc.sourceType === 'PRIMARY'
  ) {
    signals.push('Relevant supporting references')
  }
  if (doc.isOriginal) signals.push('Not substantially duplicated')
  // New: authority signal
  if (auth > 0.3) signals.push('Authoritative source (well-linked)')
  return signals.slice(0, 5)
}

/**
 * Rank candidates by mode-specific weighted score.
 *
 * P0-3 FIX: All lexical signals (tfidf / BM25) are now NORMALIZED to [0,1]
 * by dividing by the maximum score in the candidate set BEFORE being fed
 * into the linear formula. This fixes the bug where raw BM25 scores (which
 * can exceed 1.0 for strong matches) saturated clamp01() and destroyed
 * score discrimination between candidates.
 *
 * A second fix: candidates whose normalized lexical score is below a
 * threshold (0.05) are dropped — these are near-misses that should NOT
 * appear in the SERP just because the BM25 query found a token overlap.
 */
export async function rankCandidates(
  candidates: RankInput[],
  _query: string,
  mode: SearchMode,
  _filters: SearchFilters,
  parsed: ParsedQuery,
  dbDocs: Map<string, RankDocRow>,
  ctx?: RankContext
): Promise<RankedResult[]> {
  // P0-3: compute the max lexical score for normalization.
  // If maxLex is 0 (no candidates had any score — shouldn't happen since
  // candidates come from BM25 retrieval), set it to 1 to avoid division by 0.
  const maxLex = Math.max(...candidates.map((c) => c.tfidf), 0.0001)
  const minLex = Math.min(...candidates.map((c) => c.tfidf), 0)
  const queryTermSet = new Set(parsed.tokens.map((t) => t.toLowerCase()))
  const RELEVANCE_THRESHOLD = 0.05
  const MIN_COVERAGE = 0.25

  const results: RankedResult[] = []

  const freshnessKeywords = ['today', 'latest', 'breaking', 'current', 'recent', 'this week', 'this month', 'now', 'new', 'update', 'live']
  const queryLower = parsed.original.toLowerCase()
  const hasFreshnessIntent = freshnessKeywords.some(kw => queryLower.includes(kw)) || parsed.intent === 'news'

  for (const c of candidates) {
    const doc = dbDocs.get(c.docId)
    if (!doc) continue

    const lex = (c.tfidf - minLex) / (maxLex - minLex + 0.0001)
    const matchedTermSet = new Set(c.matchedTerms.map((t) => t.toLowerCase()))
    let coveredCount = 0
    for (const qt of queryTermSet) {
      if (matchedTermSet.has(qt)) coveredCount++
    }
    const coverage = queryTermSet.size > 0 ? coveredCount / queryTermSet.size : 0

    const sem = c.semanticBoost ?? semanticBoost(lex, c.matchedTerms)
    const q = doc.qualityScore
    const fr = freshnessScore(doc)
    const st = sourceTypeMatch(parsed, doc)
    const or = doc.isOriginal ? 1 : 0.3
    const intent = intentMatch(parsed, doc)
    const spam = doc.spamScore
    const dup = doc.isOriginal ? 0 : 0.3
    const auth = ctx?.authorityMap?.get(doc.domain.toLowerCase()) ?? 0

    // P0-3: skip near-miss candidates. The threshold is applied to the
    // NORMALIZED score — so if the top candidate has BM25=5.0 and another
    // candidate has BM25=0.1, the latter's normalized score is 0.02 (below
    // the 0.05 threshold) and gets dropped.
    // Exception: if the semantic boost is high (>0.4), keep the doc even if
    // its lexical score is low — it's semantically relevant despite poor
    // token match (e.g. "iphone" query → "Apple smartphone" doc).
    // EXCEPTION: DEVILS_ADVOCATE lens KEEPS near-miss candidates (the whole
    // point is to surface docs that don't strongly match — contrarian views
    // often DON'T share tokens with the user's framing).
    const lens = ctx?.lens ?? 'BALANCED'
    const isDevilsAdvocate = lens === 'DEVILS_ADVOCATE'
    if (!isDevilsAdvocate && coverage < MIN_COVERAGE && mode !== 'IMAGES') {
      continue
    }
    if (!isDevilsAdvocate && coverage < 0.5 && lex < RELEVANCE_THRESHOLD && sem < 0.4 && mode !== 'IMAGES') {
      continue
    }

    // --- Lens re-weighting (creative out-of-box feature) ---
    // Each lens applies a different weight profile to the signals.
    // DEVILS_ADVOCATE: INVERTS the lexical signal (1 - lex) so docs that
    //   DON'T match as strongly surface FIRST. Plus boosts COMMUNITY + NEWS
    //   source types (where dissent typically lives).
    // Other lenses: standard re-weighting.
    let lexWeight = 0.30, semWeight = 0.18, qWeight = 0.15, frWeight = 0.10,
        stWeight = 0.09, orWeight = 0.05, intentWeight = 0.05, authWeight = 0.08
    let sourceTypeBoost = 0  // additive boost for the lens's preferred source type
    let lexForScoring = lex  // the lexical value to use in the score formula
    if (isDevilsAdvocate) {
      // INVERT: low-BM25 docs surface first (the contrarian / dissenting / tangential views)
      lexForScoring = 1 - lex
      // Boost dissent-typical source types
      if (doc.sourceType === 'COMMUNITY') sourceTypeBoost += 0.20
      if (doc.sourceType === 'NEWS') sourceTypeBoost += 0.10
      // De-emphasize lexical (already inverted) + boost quality + originality
      // (we want well-argued dissent, not spam)
      lexWeight = 0.15; semWeight = 0.10; qWeight = 0.25; frWeight = 0.05
      stWeight = 0.05; orWeight = 0.15; intentWeight = 0.05; authWeight = 0.10
    } else if (lens === 'ACADEMIC') {
      if (doc.sourceType === 'ACADEMIC' || doc.sourceType === 'OFFICIAL' || doc.sourceType === 'GOVERNMENT') {
        sourceTypeBoost += 0.25
      }
      qWeight = 0.30; lexWeight = 0.20; semWeight = 0.10; frWeight = 0.05
    } else if (lens === 'NEWS') {
      if (doc.sourceType === 'NEWS') sourceTypeBoost += 0.25
      frWeight = 0.30; lexWeight = 0.15; semWeight = 0.10; qWeight = 0.10
    } else if (lens === 'PRIMARY') {
      if (doc.sourceType === 'PRIMARY') sourceTypeBoost += 0.30
      orWeight = 0.25; lexWeight = 0.20; qWeight = 0.15
    } else if (lens === 'COMMUNITY') {
      if (doc.sourceType === 'COMMUNITY') sourceTypeBoost += 0.30
      lexWeight = 0.20; semWeight = 0.20; qWeight = 0.10
    } else if (lens === 'COMMERCIAL') {
      if (doc.sourceType === 'COMMERCIAL') sourceTypeBoost += 0.30
      lexWeight = 0.20; qWeight = 0.20; frWeight = 0.10
    }

    // Title match boost
    const titleLower = (doc.title || '').toLowerCase()
    const queryLowerStr = parsed.original.toLowerCase().trim()
    let titleBoost = 0
    if (titleLower.includes(queryLowerStr) && queryLowerStr.length > 3) {
      titleBoost = 0.20
    } else {
      const titleTokens = new Set(titleLower.split(/\s+/))
      let titleTokenMatches = 0
      for (const qt of queryTermSet) {
        if (titleTokens.has(qt)) titleTokenMatches++
      }
      if (queryTermSet.size > 0 && titleTokenMatches === queryTermSet.size) {
        titleBoost = 0.15
      } else if (titleTokenMatches > 0 && titleTokenMatches >= queryTermSet.size / 2) {
        titleBoost = 0.08
      }
    }

    let score = 0
    switch (mode) {
      case 'BALANCED':
        if (hasFreshnessIntent) {
          score = 0.15 * coverage + 0.15 * lexForScoring + 0.08 * sem + 0.12 * q + 0.25 * fr + 0.06 * st + 0.05 * or + 0.05 * intent + 0.07 * auth + titleBoost
        } else {
          score = 0.30 * coverage + 0.12 * lexForScoring + 0.08 * sem + 0.08 * q + 0.05 * fr + 0.05 * st + 0.05 * or + 0.05 * intent + 0.07 * auth + titleBoost
        }
        break
      case 'EXACT':
        score = 0.65 * lexForScoring + 0.10 * fr + 0.10 * q + 0.08 * st + 0.07 * auth
        break
      case 'LATEST':
        score = 0.45 * fr + 0.18 * lexForScoring + 0.18 * q + 0.09 * st + 0.10 * auth
        break
      case 'RESEARCH': {
        const acBoost = (doc.sourceType === 'ACADEMIC' || doc.sourceType === 'OFFICIAL' || doc.sourceType === 'GOVERNMENT') ? 1 : 0
        score = 0.35 * q + 0.18 * acBoost + 0.18 * lexForScoring + 0.09 * or + 0.10 * fr + 0.10 * auth
        break
      }
      case 'OFFICIAL':
      case 'ACADEMIC':
      case 'COMMUNITY':
      case 'NEWS':
      case 'IMAGES':
        // Filter to sourceType happens at candidate retrieval (in search()).
        // For ranking, apply uniform weights.
        score = 0.36 * lexForScoring + 0.28 * q + 0.18 * st + 0.10 * fr + 0.08 * auth
        break
      default:
        score = lexForScoring
    }

    // Apply the lens's source-type boost (additive).
    score += sourceTypeBoost

    // Penalties
    score = score - spam - dup

    // Normalize to 0..1 (mode scores are already mostly in that range, but
    // EXACT mode's lex-heavy weights can overflow slightly — clamp).
    score = clamp01(score)

    const whySignals = buildWhySignals(doc, lex, c.matchedTerms, auth)
    results.push({ docId: c.docId, relevanceScore: score, whySignals })
  }

  results.sort((a, b) => b.relevanceScore - a.relevanceScore)
  return results
}
