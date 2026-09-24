/**
 * SearchHome.tsx
 * -----------------------------------------------------------------------------
 * The CIRKLE search-engine home view — a premium aurora-gradient hero with
 * the three-intersecting-circles logo (large, rotating), a glass search box,
 * a bilingual tagline (English + Arabic "دواير"), mode pills, and a
 * "system architecture" strip that visualizes the engine's real pipeline:
 *
 *   Query Understanding → BM25 Retrieval → Ranking → Diversity → AI Synthesis
 *
 * This is NOT a Google clone. The home page communicates the CIRKLE brand
 * identity (gold / teal / rose, glass morphism, aurora gradients, breathing
 * motion) and makes the engine's independent architecture visible.
 */

'use client'

import * as React from 'react'
import {
  Database, Loader2, ShieldCheck, Search, Sparkles,
  Brain, ListTree, Filter, Layers, Zap,
} from 'lucide-react'
import { motion, useReducedMotion as useFramerReducedMotion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'
import { useSearchStore } from '@/store/search-store'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import { CirkleLogo } from './CirkleLogo'
import { SearchBox } from './SearchBox'
import { ModeTabs } from './ModeTabs'
import { ThemeToggle } from './ThemeToggle'
import { CommandPalette } from './CommandPalette'
import { TrendingTicker } from './TrendingTicker'
import { TrendingSearches } from './TrendingSearches'
import { Footer } from './Footer'
import { PWARegister } from '@/components/PWARegister'
import { cn } from '@/lib/utils'

/** The search-engine pipeline stages, shown as a horizontal strip. */
const PIPELINE_STAGES = [
  { icon: Search, label: 'Query Understanding', desc: 'Intent + entity extraction' },
  { icon: Layers, label: 'BM25 Retrieval', desc: 'Own inverted index' },
  { icon: ListTree, label: 'Ranking', desc: 'Mode-weighted scoring' },
  { icon: Filter, label: 'Diversity', desc: 'Domain + cluster caps' },
  { icon: Brain, label: 'AI Synthesis', desc: 'Evidence-grounded' },
] as const

export function SearchHome() {
  const stats = useSearchStore((s) => s.stats)
  const triggerSeedCrawl = useSearchStore((s) => s.triggerSeedCrawl)
  const loadStats = useSearchStore((s) => s.loadStats)
  const hydrateFromUrl = useSearchStore((s) => s.hydrateFromUrl)
  const { toast } = useToast()
  const [seeding, setSeeding] = React.useState(false)

  // --- Hero spotlight: a soft radial gradient that follows the cursor over
  //     the hero area. We write CSS custom properties (--spot-x/y) onto the
  //     hero wrapper element so the gradient position updates smoothly at
  //     60fps without re-rendering React. requestAnimationFrame batching
  //     avoids layout thrashing on high-frequency pointermove events.
  const heroRef = React.useRef<HTMLDivElement>(null)
  const prefersReducedMotion = useFramerReducedMotion() ?? false
  React.useEffect(() => {
    if (prefersReducedMotion) return
    const wrapper = heroRef.current
    if (!wrapper) return
    // The actual spotlight overlay (child div with .hero-spotlight class).
    const spot = wrapper.querySelector<HTMLElement>('.hero-spotlight')
    if (!spot) return
    let rafId = 0
    let nextX = 0
    let nextY = 0
    const apply = () => {
      rafId = 0
      // Custom properties cascade, so set them on the wrapper — the child
      // .hero-spotlight will inherit + render its radial-gradient at that
      // position.
      wrapper.style.setProperty('--spot-x', `${nextX}px`)
      wrapper.style.setProperty('--spot-y', `${nextY}px`)
    }
    const onMove = (e: PointerEvent) => {
      const rect = wrapper.getBoundingClientRect()
      nextX = e.clientX - rect.left
      nextY = e.clientY - rect.top
      if (!rafId) rafId = requestAnimationFrame(apply)
    }
    const onEnter = () => spot.classList.add('spotlight-active')
    const onLeave = () => spot.classList.remove('spotlight-active')
    wrapper.addEventListener('pointermove', onMove, { passive: true })
    wrapper.addEventListener('pointerenter', onEnter, { passive: true })
    wrapper.addEventListener('pointerleave', onLeave, { passive: true })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      wrapper.removeEventListener('pointermove', onMove)
      wrapper.removeEventListener('pointerenter', onEnter)
      wrapper.removeEventListener('pointerleave', onLeave)
    }
  }, [prefersReducedMotion])

  React.useEffect(() => {
    void hydrateFromUrl()
    void loadStats()
  }, [hydrateFromUrl, loadStats])

  // Focus the search box on mount (after a short delay so SSR layout settles).
  React.useEffect(() => {
    const t = setTimeout(() => {
      const el = document.getElementById('cirkle-search-home') as HTMLInputElement | null
      el?.focus()
    }, 300)
    return () => clearTimeout(t)
  }, [])

  const onCrawlSeed = async () => {
    setSeeding(true)
    try {
      const res = await triggerSeedCrawl()
      if (res) {
        toast({
          title: 'Seed crawl complete',
          description: `Queued ${res.queued} · Crawled ${res.crawled} · Indexed ${res.indexed}${res.errors.length ? ` · ${res.errors.length} errors` : ''}`,
        })
        await loadStats()
      }
    } catch (e: any) {
      toast({
        title: 'Crawl failed',
        description: e?.message ?? 'Unknown error',
        // @ts-ignore — toaster supports variant
        variant: 'destructive',
      })
    } finally {
      setSeeding(false)
    }
  }

  const emptyIndex = stats !== null && stats.documents === 0

  useKeyboardShortcuts({
    onFocusSearch: () => {
      const el = document.getElementById('cirkle-search-home') as HTMLInputElement | null
      el?.focus()
      el?.select()
    },
    onEscape: () => {
      const el = document.getElementById('cirkle-search-home') as HTMLInputElement | null
      el?.blur()
    },
    onTogglePalette: () => {
      useSearchStore.getState().toggleCommandPalette()
    },
  })

  return (
    <div ref={heroRef} className="relative min-h-screen flex flex-col overflow-hidden bg-background">
      {/* Aurora gradient background — the CIRKLE brand signature. Three
          radial orbs (rose / teal / gold) that float gently. */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-aurora"
        aria-hidden
      />
      {/* Hero spotlight — a soft radial gradient that follows the cursor
          across the top ~70vh of the page. Disabled under reduced-motion
          (the .hero-spotlight class hides via display:none) and never
          tracks touch / pointer events with no hover. Listeners are bound
          to the outer wrapper so they fire even though this overlay is
          pointer-events-none. */}
      <div
        className="hero-spotlight pointer-events-none absolute inset-x-0 top-0 h-[80vh]"
        aria-hidden
      />
      {/* Floating orbs — premium motion. */}
      <motion.div
        className="pointer-events-none absolute -left-20 top-[10%] h-72 w-72 rounded-full bg-rose/20 blur-3xl"
        animate={{ y: [0, -24, 0], scale: [1, 1.08, 1] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
        aria-hidden
      />
      <motion.div
        className="pointer-events-none absolute -right-20 top-[20%] h-80 w-80 rounded-full bg-teal/20 blur-3xl"
        animate={{ y: [0, 20, 0], scale: [1, 1.06, 1] }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
        aria-hidden
      />
      <motion.div
        className="pointer-events-none absolute bottom-[5%] left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-gold/15 blur-3xl"
        animate={{ y: [0, -16, 0], scale: [1, 1.05, 1] }}
        transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
        aria-hidden
      />

      {/* Top-right controls (absolute, doesn't affect centered layout) */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-1 sm:right-4 sm:top-4">
        <ThemeToggle />
      </div>

      <main
        className="relative z-10 flex flex-1 flex-col items-center px-4 pt-[10vh] sm:pt-[14vh] lg:pt-[16vh]"
        role="main"
      >
        {/* Large rotating 3-circles logo */}
        <motion.div
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <CirkleLogo size={72} />
        </motion.div>

        {/* Bilingual wordmark + tagline */}
        <motion.div
          className="mt-4 flex flex-col items-center gap-1 text-center"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            <span className="gradient-text-gold">CIRKLE</span>
          </h1>
          <p className="font-arabic text-lg text-muted-foreground sm:text-xl" dir="rtl" lang="ar">
            دواير
          </p>
        </motion.div>

        <motion.p
          className="mt-2 text-center text-sm text-muted-foreground sm:text-base"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          Search the open web.{' '}
          <span className="font-medium text-foreground">Decide for yourself.</span>
        </motion.p>

        {/* Glass search box */}
        <motion.div
          className="mt-6 w-full"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <SearchBox variant="home" />
        </motion.div>

        {/* Mode pills */}
        <motion.div
          className="mt-4 w-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.6 }}
        >
          <ModeTabs variant="home" />
        </motion.div>

        {/* Trending ticker — auto-scrolling marquee of the most-frequent
            queries, with a Surprise Me button that picks a random one.
            Rendered ABOVE the TrendingSearches grid so the home page
            feels alive + gives the user a one-click path to a trending
            query without scrolling. */}
        <TrendingTicker className="mt-4" />

        {/* Trending searches — most-frequent queries from the index */}
        <TrendingSearches className="mt-4" />

        {/* Architecture pipeline strip — makes the engine's real stages visible */}
        <motion.div
          className="mt-8 w-full max-w-3xl"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.7 }}
        >
          <div className="glass rounded-2xl px-3 py-3 shadow-glass sm:px-4">
            <div className="mb-2 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Zap className="size-3 text-gold" aria-hidden />
              <span>The CIRKLE search pipeline</span>
            </div>
            <ol className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
              {PIPELINE_STAGES.map((stage, i) => {
                const Icon = stage.icon
                return (
                  <li key={stage.label} className="flex items-center gap-1">
                    <div className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5">
                      <Icon className="size-3.5 text-teal" aria-hidden />
                      <div className="flex flex-col leading-tight">
                        <span className="text-[11px] font-medium text-foreground">
                          {stage.label}
                        </span>
                        <span className="hidden text-[9px] text-muted-foreground sm:inline">
                          {stage.desc}
                        </span>
                      </div>
                    </div>
                    {i < PIPELINE_STAGES.length - 1 && (
                      <span className="text-muted-foreground/40" aria-hidden>
                        →
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          </div>
        </motion.div>

        {/* Privacy + index badges */}
        <motion.div
          className="mt-6 flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.8 }}
        >
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 text-teal" aria-hidden />
            Privacy-first · No tracking
          </span>
          <span aria-hidden className="text-muted-foreground/40">·</span>
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-gold" aria-hidden />
            Evidence-grounded AI
          </span>
        </motion.div>

        {/* Empty index CTA */}
        {emptyIndex && (
          <Card className="mt-8 w-full max-w-2xl border-primary/30 bg-primary/10">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-primary">
                <Database className="size-4" aria-hidden />
                Your index is empty
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-foreground/90">
              <p>
                CIRKLE runs on its own local web index. There are no documents
                indexed yet — crawl the seed list to get started. The seed list
                contains ~65 high-quality URLs spanning all source types.
              </p>
              <Button
                size="sm"
                className="mt-3 bg-primary text-primary-foreground text-white hover:bg-primary/90"
                onClick={onCrawlSeed}
                disabled={seeding}
              >
                {seeding ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    Crawling…
                  </>
                ) : (
                  <>
                    <Database className="size-3.5" aria-hidden />
                    Crawl seed list
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Index stats teaser */}
        {!emptyIndex && stats && (
          <motion.p
            className="mt-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-surface/60 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.9 }}
          >
            <Sparkles className="size-3 text-gold" aria-hidden />
            Searching{' '}
            <span className="font-mono font-semibold text-foreground">
              {stats.documents.toLocaleString()}
            </span>{' '}
            documents across{' '}
            <span className="font-mono font-semibold text-foreground">
              {stats.domains.toLocaleString()}
            </span>{' '}
            domains
          </motion.p>
        )}
      </main>

      <Footer />

      {/* Command palette overlay (toggled via Cmd/Ctrl+K) */}
      <CommandPalette />

      {/* PWA service worker registration (renders nothing — side-effect only) */}
      <PWARegister />
    </div>
  )
}

export default SearchHome
