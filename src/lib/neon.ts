// @ts-nocheck
/**
 * neon.ts
 * -----------------------------------------------------------------------------
 * Neon Postgres connection for:
 *   - Persistent search cache (survives server restarts, query hash → JSON)
 *   - Search analytics (long-term metrics storage)
 *   - Crawl job queue (event-driven via Inngest)
 *
 * Uses @neondatabase/serverless — HTTP-based, no TCP connection, perfect for
 * serverless/edge environments. Falls back gracefully if Neon is unreachable.
 * -----------------------------------------------------------------------------
 */

import { neon } from '@neondatabase/serverless'

const NEON_URL = process.env.NEON_DATABASE_URL

let _sql: ReturnType<typeof neon> | null = null
let _neonAvailable = true  // optimistic: assume available until first failure
let _neonFailedAt = 0      // timestamp of last failure
const NEON_RETRY_INTERVAL_MS = 60_000  // retry every 60s after failure

function getSql() {
  if (!NEON_URL) return null
  // If Neon failed recently, skip (don't retry for 60s)
  if (!_neonAvailable && Date.now() - _neonFailedAt < NEON_RETRY_INTERVAL_MS) {
    return null
  }
  if (!_sql) {
    try {
      _sql = neon(NEON_URL)
    } catch (e) { if (!_neonFailedAt) markNeonUnavailable(); 
      _neonAvailable = false
      _neonFailedAt = Date.now()
      return null
    }
  }
  return _sql
}

/** Mark Neon as unavailable (called when a Neon operation fails). */
function markNeonUnavailable() {
  _neonAvailable = false
  _neonFailedAt = Date.now()
}

/** Initialize Neon tables. Called once on server start. Safe to call multiple times. */
export async function initNeonSchema(): Promise<void> {
  const sql = getSql()
  if (!sql) return
  try {
    // Set a 3s statement timeout — don't block the stats endpoint
    await sql`SET statement_timeout = 3000`
    await sql`
      CREATE TABLE IF NOT EXISTS search_cache (
        query_hash TEXT PRIMARY KEY,
        query_text TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'BALANCED',
        response_json TEXT NOT NULL,
        result_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        hit_count INT DEFAULT 1
      )
    `
    await sql`
      CREATE TABLE IF NOT EXISTS search_analytics (
        id SERIAL PRIMARY KEY,
        query TEXT NOT NULL,
        mode TEXT DEFAULT 'BALANCED',
        latency_ms INT DEFAULT 0,
        result_count INT DEFAULT 0,
        cache_hit BOOLEAN DEFAULT FALSE,
        tool_used TEXT,
        zero_results BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `
    await sql`
      CREATE TABLE IF NOT EXISTS crawl_frontier (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        domain TEXT NOT NULL,
        priority INT DEFAULT 5,
        status TEXT DEFAULT 'pending',
        discovered_from TEXT,
        discovered_at TIMESTAMPTZ DEFAULT NOW(),
        last_attempted TIMESTAMPTZ,
        retry_count INT DEFAULT 0
      )
    `
    // Index for fast cache lookups
    await sql`CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at)`
    await sql`CREATE INDEX IF NOT EXISTS idx_search_cache_hash ON search_cache(query_hash)`
    await sql`CREATE INDEX IF NOT EXISTS idx_crawl_frontier_status ON crawl_frontier(status, priority DESC)`
    await sql`CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON search_analytics(timestamp DESC)`
    console.log('[neon] schema initialized')
  } catch (e: any) {
    console.error('[neon] schema init error:', e?.message)
  }
}

/** Get a cached search response from Neon. Returns null if not found or expired. */
export async function getNeonCache(queryHash: string): Promise<any | null> {
  const sql = getSql()
  if (!sql) return null
  try {
    const rows = await sql`
      UPDATE search_cache
      SET hit_count = hit_count + 1
      WHERE query_hash = ${queryHash} AND expires_at > NOW()
      RETURNING response_json
    `
    return rows.length > 0 ? JSON.parse(rows[0].response_json) : null
  } catch (e) { if (!_neonFailedAt) markNeonUnavailable(); 
    return null
  }
}

/** Store a search response in the Neon persistent cache. */
export async function setNeonCache(
  queryHash: string,
  queryText: string,
  mode: string,
  response: any,
  ttlSeconds: number = 300,
): Promise<void> {
  const sql = getSql()
  if (!sql) return
  try {
    const responseJson = JSON.stringify(response)
    const resultCount = response?.results?.length ?? 0
    await sql`
      INSERT INTO search_cache (query_hash, query_text, mode, response_json, result_count, expires_at)
      VALUES (${queryHash}, ${queryText}, ${mode}, ${responseJson}, ${resultCount}, NOW() + INTERVAL '${ttlSeconds} seconds')
      ON CONFLICT (query_hash)
      DO UPDATE SET response_json = EXCLUDED.response_json, result_count = EXCLUDED.result_count,
                    expires_at = EXCLUDED.expires_at, hit_count = search_cache.hit_count + 1
    `
  } catch (e: any) {
    console.error('[neon] cache set error:', e?.message)
  }
}

/** Record a search analytics event in Neon. */
export async function recordNeonAnalytics(metric: {
  query: string
  mode: string
  latencyMs: number
  resultCount: number
  cacheHit: boolean
  toolUsed: string | null
}): Promise<void> {
  const sql = getSql()
  if (!sql) return
  try {
    await sql`
      INSERT INTO search_analytics (query, mode, latency_ms, result_count, cache_hit, tool_used, zero_results)
      VALUES (${metric.query.slice(0, 500)}, ${metric.mode}, ${metric.latencyMs}, ${metric.resultCount},
              ${metric.cacheHit}, ${metric.toolUsed}, ${metric.resultCount === 0 && !metric.toolUsed})
    `
  } catch (e) { if (!_neonFailedAt) markNeonUnavailable(); 
    // analytics failures are non-critical
  }
}

/** Get pending URLs from the crawl frontier (for Inngest background jobs). */
export async function getPendingCrawlUrls(limit: number = 10): Promise<{ url: string; domain: string; priority: number }[]> {
  const sql = getSql()
  if (!sql) return []
  try {
    const rows = await sql`
      SELECT url, domain, priority FROM crawl_frontier
      WHERE status = 'pending'
      ORDER BY priority DESC, discovered_at ASC
      LIMIT ${limit}
    `
    return rows as { url: string; domain: string; priority: number }[]
  } catch (e) { if (!_neonFailedAt) markNeonUnavailable(); 
    return []
  }
}

/** Add a URL to the crawl frontier (discovered from extracted links). */
export async function addCrawlFrontierUrl(
  url: string,
  domain: string,
  discoveredFrom: string,
  priority: number = 3,
): Promise<void> {
  const sql = getSql()
  if (!sql) return
  try {
    await sql`
      INSERT INTO crawl_frontier (url, domain, priority, discovered_from)
      VALUES (${url}, ${domain}, ${priority}, ${discoveredFrom})
      ON CONFLICT (url) DO NOTHING
    `
  } catch (e) { if (!_neonFailedAt) markNeonUnavailable(); 
    // non-critical
  }
}

/** Mark a frontier URL as done or errored. */
export async function updateCrawlFrontierStatus(url: string, status: string): Promise<void> {
  const sql = getSql()
  if (!sql) return
  try {
    await sql`
      UPDATE crawl_frontier SET status = ${status}, last_attempted = NOW(),
             retry_count = CASE WHEN ${status} = 'error' THEN retry_count + 1 ELSE retry_count END
      WHERE url = ${url}
    `
  } catch (e) { if (!_neonFailedAt) markNeonUnavailable(); 
    // non-critical
  }
}

/** Get aggregated analytics from Neon (for the /api/metrics endpoint). */
export async function getNeonAnalytics(): Promise<any | null> {
  const sql = getSql()
  if (!sql) return null
  try {
    const stats = await sql`
      SELECT
        COUNT(*) as total_searches,
        COUNT(CASE WHEN cache_hit THEN 1 END) as cache_hits,
        COUNT(CASE WHEN zero_results THEN 1 END) as zero_results,
        AVG(latency_ms) as avg_latency,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95
      FROM search_analytics
      WHERE timestamp > NOW() - INTERVAL '1 hour'
    `
    const toolStats = await sql`
      SELECT tool_used, COUNT(*) as count
      FROM search_analytics
      WHERE tool_used IS NOT NULL AND timestamp > NOW() - INTERVAL '1 hour'
      GROUP BY tool_used
    `
    return {
      lastHour: stats[0] ?? {},
      toolUsage: toolStats,
    }
  } catch (e) { if (!_neonFailedAt) markNeonUnavailable(); 
    return null
  }
}
