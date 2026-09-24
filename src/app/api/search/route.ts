/**
 * POST /api/search — main search endpoint.
 *
 * Body:  { query: string, mode: SearchMode, filters: SearchFilters }
 * Resp:  SearchResponse (see src/lib/search/index.ts)
 *
 * The actual retrieval pipeline lives in `src/lib/search/index.ts:search()`.
 * This route is intentionally a thin, well-typed wrapper.
 */
import { NextRequest, NextResponse } from 'next/server'
import { search } from '@/lib/search'
import { checkRateLimit, getClientIP } from '@/lib/search/rate-limit'
import type { SearchMode, SearchFilters, SearchLens } from '@/lib/search/ranking'

export const runtime = 'nodejs' // Prisma + LLM client (../llm) require Node.
export const dynamic = 'force-dynamic'

const ALLOWED_MODES: SearchMode[] = [
  'BALANCED', 'EXACT', 'LATEST', 'RESEARCH',
  'OFFICIAL', 'ACADEMIC', 'COMMUNITY', 'NEWS', 'IMAGES',
]

const ALLOWED_LENSES: SearchLens[] = [
  'BALANCED', 'ACADEMIC', 'NEWS', 'PRIMARY', 'COMMUNITY', 'COMMERCIAL', 'DEVILS_ADVOCATE',
]

const ALLOWED_SOURCE_TYPES = new Set([
  'OFFICIAL', 'GOVERNMENT', 'ACADEMIC', 'NEWS',
  'COMMUNITY', 'COMMERCIAL', 'PRIMARY', 'WEB',
])

const ALLOWED_FRESHNESS = new Set([
  'ANY', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR', 'CUSTOM',
])

const ALLOWED_AI = new Set(['AUTO', 'ON', 'OFF'])
const ALLOWED_PERS = new Set(['ON', 'OFF'])
const ALLOWED_SAFE = new Set(['ON', 'OFF'])

function coerceFilters(raw: any): SearchFilters {
  const f = raw ?? {}
  const freshness = ALLOWED_FRESHNESS.has(f.freshness) ? f.freshness : 'ANY'
  const sourceTypes = Array.isArray(f.sourceTypes)
    ? f.sourceTypes.filter((s: string) => ALLOWED_SOURCE_TYPES.has(s))
    : []
  const domainDiversity =
    [0, 1, 2, 3].includes(Number(f.domainDiversity)) ? Number(f.domainDiversity) : 2
  const aiMode = ALLOWED_AI.has(f.aiMode) ? f.aiMode : 'AUTO'
  const personalization = ALLOWED_PERS.has(f.personalization) ? f.personalization : 'OFF'
  const safeSearch = ALLOWED_SAFE.has(f.safeSearch) ? f.safeSearch : 'ON'
  const page = Math.max(1, Math.min(50, Number(f.page) || 1))
  const pageSize = Math.max(1, Math.min(50, Number(f.pageSize) || 10))
  return {
    freshness: freshness as SearchFilters['freshness'],
    freshnessCustomStart: typeof f.freshnessCustomStart === 'string' ? f.freshnessCustomStart : undefined,
    freshnessCustomEnd: typeof f.freshnessCustomEnd === 'string' ? f.freshnessCustomEnd : undefined,
    sourceTypes: sourceTypes as SearchFilters['sourceTypes'],
    language: typeof f.language === 'string' && f.language.length > 0 ? f.language : undefined,
    country: typeof f.country === 'string' && f.country.length > 0 ? f.country : undefined,
    domainDiversity: domainDiversity as SearchFilters['domainDiversity'],
    aiMode: aiMode as SearchFilters['aiMode'],
    personalization: personalization as SearchFilters['personalization'],
    safeSearch: safeSearch as SearchFilters['safeSearch'],
    page,
    pageSize,
  }
}

export async function POST(req: NextRequest) {
  // --- Rate limiting (§48 security) ---
  const ip = getClientIP(req)
  const rateCheck = checkRateLimit(ip)
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please slow down.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)),
          'X-RateLimit-Remaining': '0',
        },
      },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  if (!query) {
    return NextResponse.json(
      { error: 'Query is required' },
      { status: 400 },
    )
  }
  if (query.length > 500) {
    return NextResponse.json(
      { error: 'Query too long (max 500 chars)' },
      { status: 400 },
    )
  }

  const mode: SearchMode = ALLOWED_MODES.includes(body?.mode)
    ? body.mode
    : 'BALANCED'

  // Creative lens — algorithmic perspective shift (default BALANCED).
  const lens: SearchLens = ALLOWED_LENSES.includes(body?.lens)
    ? body.lens
    : 'BALANCED'

  const filters = coerceFilters(body?.filters)

  // Anonymous session token (only used to scope SearchHistory rows when
  // personalization is ON). Never persisted across sessions; never tied to
  // any account.
  const sessionId =
    typeof body?.sessionId === 'string' && body.sessionId.length > 0
      ? body.sessionId.slice(0, 64)
      : undefined

  const personalization = filters.personalization

  try {
    const resp = await search(query, mode, filters, { sessionId, personalization, lens })
    return NextResponse.json(resp, {
      headers: {
        // Search results depend on the live index — never cache.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    })
  } catch (err: any) {
    console.error('[/api/search] error:', err)
    return NextResponse.json(
      { error: 'Search failed', detail: String(err?.message ?? err) },
      { status: 500 },
    )
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Nova Search API — POST { query, mode?, filters? } to /api/search',
    methods: ['POST'],
  })
}
