/**
 * TrendingTicker.tsx
 * -----------------------------------------------------------------------------
 * A horizontal auto-scrolling ticker of trending searches on the home
 * page, rendered above the TrendingSearches grid.
 *
 *   - Pulls from /api/trending (same source as <TrendingSearches>).
 *   - Auto-scrolls horizontally via CSS animation (@keyframes cirkleTicker
 *     in globals.css). The track is duplicated so the scroll loops
 *     seamlessly.
 *   - Hover pauses the scroll (CSS .group-hover: pause-on-hover).
 *   - Each item: clickable chip — sets the query + executes search.
 *   - "🎲 Surprise Me" button at the end → picks a random trending query
 *     and searches it.
 *
 * Reduced-motion users: the ticker animation is disabled in globals.css
 * (the @media (prefers-reduced-motion: reduce) override sets
 * animation: none on .trending-ticker-track). The chips still render and
 * remain clickable — they just don't auto-scroll.
 */

'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { Dice5, TrendingUp } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useSearchStore } from '@/store/search-store'
import { cn } from '@/lib/utils'

interface TrendingTickerProps {
  className?: string
}

interface TrendingEntry {
  query: string
  frequency: number
}

export function TrendingTicker({ className }: TrendingTickerProps) {
  const [trending, setTrending] = React.useState<TrendingEntry[]>([])
  const setQuery = useSearchStore((s) => s.setQuery)
  const executeSearch = useSearchStore((s) => s.executeSearch)
  const { toast } = useToast()

  React.useEffect(() => {
    fetch('/api/trending')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.trending)) setTrending(d.trending)
      })
      .catch(() => {})
  }, [])

  const onClick = (q: string) => {
    setQuery(q)
    void executeSearch()
  }

  const onSurprise = () => {
    if (trending.length === 0) return
    const pick = trending[Math.floor(Math.random() * trending.length)]
    onClick(pick.query)
    toast({
      title: 'Surprise me',
      description: `Searching for: ${pick.query}`,
    })
  }

  if (trending.length === 0) return null

  // Duplicate the list so the ticker scrolls seamlessly in a loop. The
  // CSS keyframe translates from 0 → -50%, which lands on the start of
  // the duplicated copy with no visible jump.
  const doubled = [...trending, ...trending]

  return (
    <motion.div
      className={cn('w-full max-w-3xl', className)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.85 }}
    >
      <div className="glass overflow-hidden rounded-full px-3 py-2 shadow-glass">
        <div className="flex items-center gap-2">
          <div className="flex shrink-0 items-center gap-1 pr-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="size-3 text-gold" aria-hidden />
            Trending
          </div>
          {/* The auto-scrolling track. aria-hidden wrapper hides the
              duplicate copy from screen readers — AT users see the real
              chips below. */}
          <div
            className="trending-ticker relative flex-1 overflow-hidden"
            aria-label="Trending searches ticker"
          >
            <div className="trending-ticker-track" aria-hidden="true">
              {doubled.map((t, i) => (
                <button
                  key={`${t.query}-${i}`}
                  onClick={() => onClick(t.query)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-full',
                    'border border-border/60 bg-surface/60 px-2.5 py-1 text-xs text-foreground/80',
                    'hover:border-gold/40 hover:bg-gold/10 hover:text-gold',
                    'transition-all duration-200',
                  )}
                  style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                >
                  <span className="font-mono text-[10px] text-gold/70">
                    {(i % trending.length) + 1}
                  </span>
                  {t.query}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={onSurprise}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full',
              'border border-gold/40 bg-gold/10 px-2.5 py-1 text-xs text-gold',
              'hover:bg-gold/20 hover:border-gold/60 transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold',
            )}
            style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
            aria-label="Surprise me — search a random trending query"
          >
            <Dice5 className="size-3.5" aria-hidden />
            Surprise me
          </button>
        </div>
      </div>

      {/* Visually-hidden list of real chips for screen readers — the
          ticker above is aria-hidden because its duplicate copy would be
          read twice. AT users get this clean static list instead. */}
      <ul className="sr-only" aria-label="All trending searches">
        {trending.map((t, i) => (
          <li key={`sr-${t.query}-${i}`}>
            <button onClick={() => onClick(t.query)}>
              {i + 1}. {t.query}
            </button>
          </li>
        ))}
      </ul>
    </motion.div>
  )
}

/**
 * Inline helper: returns the toast function from the useToast hook, or a
 * no-op if the hook isn't available. Wrapped to avoid importing the hook
 * at the top-level (some sandboxed test environments don't wire the
 * Toaster). In production, this always returns the real toast.
 */
// (helper removed — useToast is now imported directly at the top of file)

export default TrendingTicker
