/**
 * SearchResults.tsx
 * -----------------------------------------------------------------------------
 * The main SERP (Search Engine Results Page). Renders:
 *
 *   - <SearchHeader> (sticky, white/blur backdrop)
 *   - <QueryDna> (algorithmic introspection of the query — tokens, intent,
 *     entities, languages, countries — replaces the legacy InterpretedQuery)
 *   - <SearchLenses> (toggleable lens pills — Devil's Advocate inverts the
 *     ranking to surface dissenting views)
 *   - Sponsored section: clearly labeled "Sponsored" header, then
 *     <SponsoredCard> list (max 3). Amber divider above + below.
 *   - "About N results (M seconds)" line.
 *   - "Did you mean …?" suggestion (if present) as a clickable link.
 *   - <AIAnswer> (if present)
 *   - Results list: <ResultCard> for each result, with <Separator> between.
 *     Each card renders a <SourceDna> strip + 3D parallax tilt on hover.
 *   - Cluster expansion: if `clusters` has clusters with size > 1, render a
 *     "Related results (cluster)" section after the primary results.
 *   - <RelatedQuestions> (if relatedQuestions.length > 0)
 *   - <Pagination>
 *   - <Footer>
 *
 * Loading state: 5 <Skeleton> cards mimicking ResultCard shape.
 * Empty state (0 results): friendly card with "Crawl more sources" button.
 * Error state: red-tinted alert with the error message + retry button.
 *
 * Mounted on the `/` route (orchestrator wires the ?q= param). The store
 * hydrates from URL on mount, then executes the search.
 */

'use client'

import * as React from 'react'
import {
  AlertCircle,
  Search as SearchIcon,
  Sparkles,
  RefreshCw,
  Database,
  Clock,
  Loader2,
} from 'lucide-react'
import {
  motion,
  useMotionValue,
  useSpring,
  animate,
  useReducedMotion as useFramerReducedMotion,
  type Variants,
} from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'
import { useSearchStore } from '@/store/search-store'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { SearchHeader } from './SearchHeader'
import { SearchPipeline } from './SearchPipeline'
import { CommandPalette } from './CommandPalette'
import { QueryDna } from './QueryDna'
import { SearchLenses } from './SearchLenses'
import { AIAnswer } from './AIAnswer'
import { KnowledgeCard } from './KnowledgeCard'
import { KnowledgeSidebar } from './KnowledgeSidebar'
import { SponsoredCard } from './SponsoredCard'
import { InstantAnswerCard } from './InstantAnswerCard'
import { ResultCard } from './ResultCard'
import { ImageGrid } from './ImageGrid'
import { PageSummaryDialog } from './PageSummaryDialog'
import { RelatedQuestions } from './RelatedQuestions'
import { Pagination } from './Pagination'
import { Footer } from './Footer'
import { PWARegister } from '@/components/PWARegister'
import { formatCount, formatRelativeTime } from './format'

export function SearchResults() {
  const results = useSearchStore((s) => s.results)
  const loading = useSearchStore((s) => s.loading)
  const mode = useSearchStore((s) => s.mode)
  const lens = useSearchStore((s) => s.lens)
  const aiLayerLoading = useSearchStore((s) => s.aiLayerLoading)
  const error = useSearchStore((s) => s.error)
  const query = useSearchStore((s) => s.query)
  const setQuery = useSearchStore((s) => s.setQuery)
  const setFilters = useSearchStore((s) => s.setFilters)
  const executeSearch = useSearchStore((s) => s.executeSearch)
  const triggerSeedCrawl = useSearchStore((s) => s.triggerSeedCrawl)
  const loadStats = useSearchStore((s) => s.loadStats)
  const hydrateFromUrl = useSearchStore((s) => s.hydrateFromUrl)
  const { toast } = useToast()

  // Hydrate from URL on mount (idempotent — safe if the orchestrator's
  // page.tsx also calls it).
  React.useEffect(() => {
    void hydrateFromUrl()
  }, [hydrateFromUrl])

  // Track the time the search started so we can show "(M seconds)".
  const [startedAt, setStartedAt] = React.useState<number | null>(null)
  const [elapsed, setElapsed] = React.useState<number | null>(null)
  const [summaryDocId, setSummaryDocId] = React.useState<string | null>(null)
  const [summaryResult, setSummaryResult] = React.useState<{ title: string; url: string; sourceType: string } | null>(null)

  React.useEffect(() => {
    if (loading) setStartedAt(performance.now())
  }, [loading])

  React.useEffect(() => {
    if (!loading && startedAt) {
      setElapsed((performance.now() - startedAt) / 1000)
      setStartedAt(null)
    }
  }, [loading, startedAt])

  const onPageChange = React.useCallback(
    (p: number) => {
      setFilters({ page: p })
      void executeSearch()
      // Scroll back to the top of the SERP after a page change.
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    },
    [setFilters, executeSearch],
  )

  const onSelectRelatedQuestion = React.useCallback(
    (q: string) => {
      setQuery(q)
      setFilters({ page: 1 })
      void executeSearch()
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    },
    [setQuery, setFilters, executeSearch],
  )

  const onDidYouMean = React.useCallback(
    (s: string) => {
      setQuery(s)
      setFilters({ page: 1 })
      void executeSearch()
    },
    [setQuery, setFilters, executeSearch],
  )

  const onSeedCrawl = React.useCallback(async () => {
    try {
      const res = await triggerSeedCrawl()
      if (res) {
        toast({
          title: 'Seed crawl complete',
          description: `Queued ${res.queued} · Crawled ${res.crawled} · Indexed ${res.indexed}${res.errors.length ? ` · ${res.errors.length} errors` : ''}`,
        })
        await loadStats()
        // Re-run the user's search after the crawl.
        void executeSearch()
      }
    } catch (e: any) {
      toast({
        title: 'Crawl failed',
        description: e?.message ?? 'Unknown error',
        // @ts-ignore — toaster supports variant
        variant: 'destructive',
      })
    }
  }, [triggerSeedCrawl, loadStats, executeSearch, toast])

  // Global keyboard shortcuts: "/" or Cmd/Ctrl+K focuses the header search
  // box, Esc blurs it (so arrow keys can scroll the results).
  useKeyboardShortcuts({
    onFocusSearch: () => {
      const el = document.getElementById('cirkle-search-header') as HTMLInputElement | null
      el?.focus()
      el?.select()
    },
    onEscape: () => {
      const el = document.activeElement as HTMLInputElement | null
      if (el && el.tagName === 'INPUT') el.blur()
    },
    onTogglePalette: () => {
      useSearchStore.getState().toggleCommandPalette()
    },
  })

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SearchHeader />

      <main
        id="cirkle-search-results"
        role="region"
        aria-label="Search results"
        aria-busy={loading}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6 lg:px-8"
      >
        {/* Query DNA — algorithmic introspection of the user's query.
            Replaces the legacy InterpretedQuery panel. Shows tokens
            (POS-colored chips), intent, entities, languages, countries,
            and a quick stats line. Spring entrance. Renders whenever the
            user has typed a query (even before results arrive — the
            component derives tokens from the raw query as a fallback
            when the server-emitted parsed object is unavailable). */}
        {(results?.interpretedQuery || query.trim()) && (
          <QueryDna className="mb-4" />
        )}

        {/* Search Lenses — creative perspective-shifting pills. Clicking a
            lens updates the store + triggers a re-search with the new lens
            in the request body; the result cards re-rank with a spring
            animation (key change on the motion.section below re-triggers
            the staggered entrance). Devil's Advocate INVERTS the ranking
            to surface dissenting views. */}
        <SearchLenses className="mb-4" />

        {/* Instant answer — real-time tool results (weather / time / math).
            Shown at the TOP of the SERP, above everything else. These answer
            instantly (1-2s) via direct API calls — no index lookup, no AI. */}
        {results?.instantAnswer && (
          <div className="mb-4">
            <InstantAnswerCard answer={results.instantAnswer} />
          </div>
        )}

        {/* Live web fallback — when the local index returned 0 results, we
            fetch fresh web results via the web_search SDK (spec §69
            supplementary source). Clearly labeled, not mixed with organic. */}
        {results?.liveWebResults && results.liveWebResults.length > 0 && (
          <section aria-label="Live web results" className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <Separator className="flex-1 bg-teal/40" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-teal">
                Live web — outside the CIRKLE index
              </span>
              <Separator className="flex-1 bg-teal/40" />
            </div>
            <ul className="space-y-2">
              {results.liveWebResults.slice(0, 5).map((r, i) => (
                <li key={i} className="rounded-lg border border-border/60 p-3 hover:bg-surface/40">
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground hover:text-primary hover:underline">
                    {r.title}
                  </a>
                  <p className="mt-0.5 text-xs text-muted-foreground">{r.domain}</p>
                  <p className="mt-1 text-sm text-foreground/80">{r.snippet}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Sponsored section */}
        {results?.sponsored && results.sponsored.length > 0 && (
          <section
            aria-label="Sponsored results"
            className="mb-4"
          >
            <div className="flex items-center gap-2">
              <Separator className="flex-1 bg-amber-300/60" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-amber-700">
                Sponsored
              </span>
              <Separator className="flex-1 bg-amber-300/60" />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              {results.sponsored.slice(0, 3).map((ad) => (
                <SponsoredCard key={ad.id} ad={ad} />
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Separator className="flex-1 bg-amber-300/60" />
              <span className="text-[10px] text-muted-foreground">
                End of sponsored results
              </span>
              <Separator className="flex-1 bg-amber-300/60" />
            </div>
          </section>
        )}

        {/* Search pipeline indicator — shows the engine's real stages */}
        {(loading || (results && !error)) && (
          <div className="mb-3">
            <SearchPipeline
              loading={loading}
              hasResults={!!results && results.results.length > 0}
              aiUsed={!!results?.aiAnswer}
            />
          </div>
        )}

        {/* Result count + timing. The count + seconds animate (count-up
            from 0) so the SERP feels alive + responsive instead of just
            snapping in. */}
        {results && !loading && !error && (
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>
              About{' '}
              <span className="font-medium text-foreground">
                <CountUp value={results.pagination.totalResults} />
              </span>{' '}
              results
              {elapsed != null && (
                <span className="ml-1 text-xs">
                  (<CountUp
                    value={elapsed}
                    duration={0.7}
                    format={(n) => n.toFixed(2)}
                  />{' '}
                  seconds)
                </span>
              )}
            </span>
            {results.personalized && (
              <span className="inline-flex items-center gap-1 text-xs text-primary">
                <Sparkles className="size-3" aria-hidden />
                Personalized
              </span>
            )}
            {results.indexStats && results.indexStats.lastCrawl && (
              <span className="inline-flex items-center gap-1 text-xs">
                <Clock className="size-3" aria-hidden />
                Index updated {formatRelativeTime(results.indexStats.lastCrawl)}
              </span>
            )}
          </div>
        )}

        {/* Did you mean? */}
        {results?.didYouMean && !loading && (
          <p className="mb-3 text-sm">
            <span className="text-muted-foreground">Did you mean </span>
            <button
              type="button"
              onClick={() => onDidYouMean(results.didYouMean!)}
              className="font-medium text-primary underline underline-offset-2 hover:text-primary"
            >
              {results.didYouMean}
            </button>
            <span className="text-muted-foreground">?</span>
          </p>
        )}

        {/* AI answer — renders immediately when ready, or shows a loading
            skeleton while the lazy AI layer generates (so the user knows AI
            is coming, not broken). */}
        {results?.aiAnswer && !loading && (
          <div className="mb-4">
            <AIAnswer aiAnswer={results.aiAnswer} />
          </div>
        )}
        {/* AI Overview loading state — shimmer lines inside a glass card
            that visually matches the final AI Overview (so the layout
            doesn't shift when the answer arrives). Uses the same gold
            left accent + shadow-glass as the real card. */}
        {!loading && !results?.aiAnswer && aiLayerLoading && (
          <div
            className="glass mb-4 overflow-hidden rounded-xl border-l-2 border-l-gold p-4 shadow-glass"
            role="status"
            aria-live="polite"
            aria-label="Generating AI overview"
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-gold" aria-hidden />
              <span>Synthesizing evidence-grounded AI answer…</span>
            </div>
            <div className="mt-3 space-y-2">
              <ShimmerBar className="h-3.5 w-full" />
              <ShimmerBar className="h-3.5 w-[88%]" />
              <ShimmerBar className="h-3.5 w-[68%]" />
            </div>
          </div>
        )}

        {/* Loading state — 5 skeleton cards with a shimmer sweep overlay.
            Mirrors the ResultCard layout (favicon + domain + title + URL +
            two snippet lines + metadata badges) so the layout doesn't shift
            when real results arrive. role=status + aria-busy on <main>
            above already tells AT users what's happening. */}
        {loading && (
          <div
            className="space-y-1"
            role="status"
            aria-label="Loading search results"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <ResultCardSkeleton key={i} />
            ))}
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <Card className="border-rose bg-rose">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-rose">
                <AlertCircle className="size-4" aria-hidden />
                Search failed
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-rose">
              <p>{error}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 border-rose text-rose hover:bg-rose"
                onClick={() => void executeSearch()}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                Retry search
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Empty state */}
        {!loading && !error && results && results.results.length === 0 && (
          <Card className="border-primary/30 bg-primary/10">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-primary">
                <SearchIcon className="size-4" aria-hidden />
                No results found for “{query}”
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-foreground/90">
              <p>
                CIRKLE's index might not cover this topic yet. Try different
                keywords, change filters, or crawl more sources to grow the
                index.
              </p>
              <Button
                size="sm"
                className="mt-3 bg-primary text-primary-foreground text-white hover:bg-primary/90"
                onClick={onSeedCrawl}
              >
                <Database className="size-3.5" aria-hidden />
                Crawl more sources
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Organic results list + Knowledge Sidebar (desktop) / inline
            Knowledge Card (mobile). IMAGES mode renders an image grid
            instead of text cards. */}
        {!loading && !error && results && results.results.length > 0 && mode === 'IMAGES' && (
          <div>
            <ImageGrid results={results.results} />
          </div>
        )}
        {/* Normal text results (all non-IMAGES modes). Staggered entrance:
            each card springs in from y:12 with a 50ms stagger (capped at
            ~10 cards so long lists don't drag). whileHover lifts the card
            by 2px without breaking the existing border-l-2 hover effect
            (that's on the inner <article>, this is the outer wrapper). */}
        {!loading && !error && results && results.results.length > 0 && mode !== 'IMAGES' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
            {/* Mobile-only inline knowledge card at the top of the results.
                Hidden at lg+ where the sidebar takes over. */}
            {results.knowledgeCard && (
              <div className="mb-2 lg:hidden">
                <KnowledgeCard card={results.knowledgeCard} />
              </div>
            )}
            <motion.section
              // Key on the lens so when the user clicks a different lens,
              // the staggered entrance re-triggers and the cards
              // spring-re-rank into their new order. This is what makes the
              // SearchLenses UI feel "live".
              key={`${lens}-${results.pagination.page}`}
              aria-label="Organic results"
              className="min-w-0 space-y-0"
              variants={RESULTS_CONTAINER_VARIANTS}
              initial="hidden"
              animate="show"
            >
              {results.results.map((r, i) => (
                <React.Fragment key={r.id}>
                  {i > 0 && <Separator className="my-0" />}
                  <motion.div
                    variants={RESULT_ITEM_VARIANTS}
                    whileHover={{ y: -2, transition: { duration: 0.2 } }}
                  >
                    <ResultCard
                      result={r}
                      rank={i + 1 + (results.pagination.page - 1) * results.pagination.pageSize}
                      onSummary={(docId) => {
                        setSummaryDocId(docId)
                        setSummaryResult({ title: r.title, url: r.url, sourceType: r.sourceType })
                      }}
                    />
                  </motion.div>
                </React.Fragment>
              ))}
            </motion.section>
            {/* Desktop-only sticky knowledge sidebar. */}
            {results.knowledgeCard && (
              <aside
                aria-label="Knowledge sidebar"
                className="hidden lg:block"
              >
                <KnowledgeSidebar card={results.knowledgeCard} />
              </aside>
            )}
          </div>
        )}

        {/* Mobile: knowledge card above organic results when no results yet (e.g., 0 results but entity detected) */}
        {!loading &&
          !error &&
          results &&
          results.results.length === 0 &&
          results.knowledgeCard && (
            <div className="mb-4">
              <KnowledgeCard card={results.knowledgeCard} />
            </div>
          )}

        {/* Cluster expansion */}
        {!loading &&
          !error &&
          results &&
          results.clusters &&
          results.clusters.filter((c) => c.size > 1).length > 0 && (
            <section
              aria-label="Related results (cluster)"
              className="mt-8"
            >
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                Related results — collapsed by domain diversity
              </h2>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {results.clusters
                  .filter((c) => c.size > 1)
                  .map((c) => (
                    <li
                      key={c.id}
                      className="rounded-md border border-border bg-muted/30 px-2 py-1.5"
                    >
                      Cluster{' '}
                      <span className="font-mono">{c.id.slice(0, 12)}</span>{' '}
                      · {c.size} near-duplicate
                      {c.size === 1 ? '' : 's'} suppressed.
                    </li>
                  ))}
              </ul>
            </section>
          )}

        {/* Related questions */}
        {!loading && !error && results && results.relatedQuestions.length > 0 && (
          <RelatedQuestions
            questions={results.relatedQuestions}
            onSelect={onSelectRelatedQuestion}
          />
        )}

        {/* Pagination */}
        {!loading && !error && results && results.results.length > 0 && (
          <Pagination
            pagination={results.pagination}
            onPageChange={onPageChange}
          />
        )}
      </main>

      {/* Command palette overlay (toggled via Cmd/Ctrl+K) */}
      <CommandPalette />

      {/* Page summary dialog — the "advanced browser" feature */}
      {summaryResult && (
        <PageSummaryDialog
          docId={summaryDocId}
          resultTitle={summaryResult.title}
          resultUrl={summaryResult.url}
          resultSourceType={summaryResult.sourceType}
          onClose={() => { setSummaryDocId(null); setSummaryResult(null) }}
        />
      )}

      <Footer />

      {/* PWA service worker registration (renders nothing — side-effect only) */}
      <PWARegister />
    </div>
  )
}

/**
 * Loading skeleton for a single ResultCard. Uses the shadcn <Skeleton> base
 * (rounded-md + animate-pulse) PLUS a moving `.shimmer-overlay` highlight
 * sweep on top — gives a premium "data is loading" feel rather than a static
 * grey block. The aria-hidden + role=status wrapper makes it polite to screen
 * readers.
 *
 * Layout mirrors ResultCard: favicon(16px) + domain(14px) on top, full-width
 * title (20px), URL (14px), then two snippet lines (14px @ 90% + 70%).
 */
function ResultCardSkeleton() {
  return (
    <div className="py-4" aria-hidden="true">
      {/* Favicon + domain */}
      <div className="relative flex items-center gap-2">
        <ShimmerBar className="size-4 rounded-sm" />
        <ShimmerBar className="h-3.5 w-40" />
      </div>
      {/* Title */}
      <ShimmerBar className="mt-2 h-5 w-3/4" />
      {/* URL breadcrumb */}
      <ShimmerBar className="mt-1 h-3 w-1/2" />
      {/* Snippet line 1 (90% width) */}
      <ShimmerBar className="mt-2 h-3.5 w-[90%]" />
      {/* Snippet line 2 (70% width) */}
      <ShimmerBar className="mt-1 h-3.5 w-[70%]" />
      {/* Metadata badges */}
      <div className="mt-2 flex gap-2">
        <ShimmerBar className="h-4 w-14" />
        <ShimmerBar className="h-4 w-16" />
        <ShimmerBar className="h-4 w-12" />
      </div>
    </div>
  )
}

/**
 * A single shimmer bar: the shadcn <Skeleton> base + an absolutely-positioned
 * `.shimmer-overlay` sweep on top. The parent <Skeleton> is `relative` so
 * the overlay aligns to the bar's rounded corners.
 *
 * Reduced-motion users see no sweep (the `.shimmer-overlay` class hides via
 * display:none under `prefers-reduced-motion: reduce`).
 */
function ShimmerBar({ className }: { className?: string }) {
  return (
    <Skeleton className={cn('relative overflow-hidden', className)}>
      <span className="shimmer-overlay" />
    </Skeleton>
  )
}

/**
 * Count-up display: animates a number from 0 → N over 800ms using Framer
 * Motion's `animate()` (spring physics for a satisfying deceleration).
 * Re-runs whenever `value` changes (e.g. when a new search returns).
 *
 * Used for "About N results" so the number ticks up rather than appearing
 * instantly — feels faster + more alive than a hard swap.
 */
function CountUp({
  value,
  duration = 0.8,
  format = (n: number) => formatCount(Math.round(n)),
  className,
}: {
  value: number
  duration?: number
  format?: (n: number) => string
  className?: string
}) {
  const mv = useMotionValue(0)
  // Spring-smoothed motion value — the spring's damping/stiffness produce
  // the satisfying "settle" feel rather than a linear tween.
  const spring = useSpring(mv, { stiffness: 90, damping: 18, mass: 0.6 })
  const [display, setDisplay] = React.useState('0')
  const prefersReducedMotion = usePrefersReducedMotion()

  // Animate the motion value from 0 → value whenever `value` changes.
  React.useEffect(() => {
    if (prefersReducedMotion) {
      setDisplay(format(value))
      return
    }
    const controls = animate(mv, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
    })
    return () => controls.stop()
  }, [value, duration, mv, prefersReducedMotion, format])

  // Subscribe to spring changes → format + setState. Wrapped in rAF-throttled
  // requestAnimationFrame so we don't re-render React 60x/sec.
  React.useEffect(() => {
    let rafId = 0
    const update = (v: number) => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        setDisplay(format(v))
      })
    }
    const unsub = spring.on('change', update)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      unsub()
    }
  }, [spring, format])

  return <span className={className}>{display}</span>
}

/**
 * Framer Motion variants for the staggered entrance of result cards. The
 * container orchestrates children with a 50ms stagger; each child springs
 * in from y:12 with a slight scale-up.
 */
const RESULTS_CONTAINER_VARIANTS: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.02,
      // Cap the stagger so a 10-result page finishes around 0.45s — long
      // result lists don't drag the entrance out forever.
      staggerDirection: 1,
    },
  },
}

const RESULT_ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.98 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 220,
      damping: 22,
      mass: 0.9,
    },
  },
}

/**
 * Hook: returns true if the user prefers reduced motion. Same as
 * framer-motion's `useReducedMotion` but normalizes to a boolean (the
 * framer-motion hook returns `null` before mount which is awkward for
 * effect deps).
 */
function usePrefersReducedMotion(): boolean {
  const v = useFramerReducedMotion()
  return v ?? false
}

export default SearchResults
