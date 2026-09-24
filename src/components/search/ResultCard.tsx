/**
 * ResultCard.tsx
 * -----------------------------------------------------------------------------
 * A single organic search-result card (Google-like).
 *
 * Layout:
 *  - Top line: small favicon-style dot (color from source-type) + domain +
 *    breadcrumb path. On the right: a "⋯ More" dropdown menu with options:
 *    "Open source", "Source profile", "Why this result?", "Copy link".
 *  - Title (large, link, primary-on-hover, opens new tab, rel="noopener
 *    noreferrer").
 *  - URL breadcrumb below title.
 *  - Snippet (3 lines max, with <mark> highlighting matched query terms in
 *    bg-primary/20).
 *  - Source DNA strip (NEW): a 100×6px "genetic fingerprint" with 6 colored
 *    segments encoding source-type / country / language / quality /
 *    originality / freshness. See <SourceDna>.
 *  - Metadata row: source-type badge (colored), date (relative), language,
 *    originality badge ("Original" primary / "Duplicate" slate when !isOriginal).
 *  - If clusterSize > 1: a small "n more from this cluster" link that
 *    expands an inline list of suppressed cluster members (placeholder list
 *    of clusterId/size — actual cluster members fetched from the parent).
 *  - "Why this result?" — collapsible. Trigger button shows "Why this result?"
 *    with a help icon. When open, shows the §15 checklist from whyThisResult[].
 *  - Relevance score shown as a tiny progress bar in the corner (visual only,
 *    labeled Low/Medium/High — per §15 we never expose the actual numeric
 *    weight).
 *  - Feedback row at the bottom-right: 👍 / 👎 / Report. Submits to
 *    /api/feedback, persists in localStorage per (query, docId) so the user
 *    can't vote twice on the same pair. See <ResultFeedback>.
 *
 * Premium 3D parallax tilt (NEW): as the cursor moves over the card, the
 * card tilts toward the cursor (max ±3deg). Uses Framer Motion motion
 * values + spring for smooth settle-back-to-zero on mouse leave.
 * Disabled on touch devices (no hover) and under prefers-reduced-motion.
 * The tilt compounds with the parent motion.div's `whileHover={{ y: -2 }}`
 * lift in <SearchResults> — both effects fire simultaneously so the card
 * lifts AND tilts.
 */

'use client'

import * as React from 'react'
import {
  motion,
  useMotionValue,
  useSpring,
  useReducedMotion as useFramerReducedMotion,
  useTransform,
} from 'framer-motion'
import {
  MoreHorizontal,
  ExternalLink,
  Info,
  Copy,
  Check,
  BookOpen,
  Users,
  Globe,
  Calendar,
  FileText,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'
import { useSearchStore } from '@/store/search-store'
import { cn } from '@/lib/utils'
import { sourceTypeStyle } from './source-type'
import {
  formatRelativeTime,
  formatShortDate,
  highlightSnippet,
  truncateLines,
  urlParts,
  matchStrength,
} from './format'
import { WhyThisResult } from './WhyThisResult'
import { ResultFeedback } from './ResultFeedback'
import { SourceDna } from './SourceDna'
import type { SearchResult } from './types'

export interface ResultCardProps {
  result: SearchResult
  rank: number
  onSummary?: (docId: string) => void
}

export function ResultCard({ result, rank, onSummary }: ResultCardProps) {
  const query = useSearchStore((s) => s.query)
  const openSourceProfile = useSearchStore((s) => s.openSourceProfile)
  const [whyOpen, setWhyOpen] = React.useState(false)
  const [clusterOpen, setClusterOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  // Favicon state: try to load the real favicon; if it fails, fall back
  // to the source-type colored dot.
  const [faviconError, setFaviconError] = React.useState(false)

  // --- 3D Parallax Tilt ---------------------------------------------------
  // Subtle premium effect: as the cursor moves over the card, the card
  // tilts toward the cursor (max ±6deg). Disabled on touch devices (no
  // hover) and under prefers-reduced-motion. Uses Framer Motion motion
  // values + spring for a smooth settle-back-to-zero on mouse leave.
  const prefersReducedMotion = useFramerReducedMotion() ?? false
  // We detect touch devices via pointer: coarse media query — these have
  // no hover, so the tilt would fire on scroll-jank. Skip the effect.
  const [isTouch, setIsTouch] = React.useState(false)
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(pointer: coarse)')
    const update = () => setIsTouch(mq.matches)
    update()
    try {
      mq.addEventListener?.('change', update)
    } catch {
      // Safari < 14 fallback
      mq.addListener(update)
    }
    return () => {
      try {
        mq.removeEventListener?.('change', update)
      } catch {
        mq.removeListener(update)
      }
    }
  }, [])
  const tiltEnabled = !prefersReducedMotion && !isTouch

  // Raw mouse position as motion values [0..1] within the card bounds.
  const mvX = useMotionValue(0.5)
  const mvY = useMotionValue(0.5)
  // Spring-smoothed position so the tilt eases in/out rather than snapping.
  const smoothX = useSpring(mvX, { stiffness: 220, damping: 22, mass: 0.4 })
  const smoothY = useSpring(mvY, { stiffness: 220, damping: 22, mass: 0.4 })
  // Tilt: (x - 0.5) * 6deg → ±3deg range (subtle, premium).
  const rotateY = useTransform(smoothX, (v) => (v - 0.5) * 6)
  const rotateX = useTransform(smoothY, (v) => (0.5 - v) * 6)

  const cardRef = React.useRef<HTMLDivElement>(null)
  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!tiltEnabled) return
      const el = cardRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      const y = (e.clientY - rect.top) / rect.height
      // Clamp to [0,1] — pointer can briefly leave the rect during fast moves.
      mvX.set(Math.max(0, Math.min(1, x)))
      mvY.set(Math.max(0, Math.min(1, y)))
    },
    [tiltEnabled, mvX, mvY],
  )
  const onPointerLeave = React.useCallback(() => {
    if (!tiltEnabled) return
    mvX.set(0.5)
    mvY.set(0.5)
  }, [tiltEnabled, mvX, mvY])

  const st = sourceTypeStyle(result.sourceType)
  const { host, path } = urlParts(result.url)
  const dateIso = result.updatedAt ?? result.publishedAt
  const relDate = formatRelativeTime(dateIso)
  const strength = matchStrength(result.relevanceScore)
  const strengthPct =
    strength === 'High' ? 90 : strength === 'Medium' ? 60 : 30

  // Favicon URL: Google's S2 favicon service. `sz=32` returns a 32x32 PNG
  // that we display at 16x16 (size-4) on retina screens.
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`

  const onCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(result.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <motion.article
      ref={cardRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      style={{
        perspective: tiltEnabled ? 1000 : undefined,
        rotateX: tiltEnabled ? rotateX : 0,
        rotateY: tiltEnabled ? rotateY : 0,
        transformStyle: tiltEnabled ? 'preserve-3d' : undefined,
        transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      className={cn(
        'group relative -mx-2 rounded-xl px-2 py-4 transition-all duration-300',
        'hover:bg-surface/60 hover:shadow-soft',
        'border-l-2 border-l-transparent hover:border-l-primary/40',
      )}
      aria-label={`Result ${rank}: ${result.title}`}
      data-result-id={result.id}
    >
      {/* Top line: favicon + domain + path + more menu */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span
            className="inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm"
            aria-hidden
          >
            {faviconError ? (
              // Fallback: the original source-type colored dot.
              <span
                className={cn(
                  'inline-block size-2.5 rounded-full',
                  st.favicon,
                )}
              />
            ) : (
              <img
                src={faviconUrl}
                alt=""
                width={16}
                height={16}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setFaviconError(true)}
                className="size-4 object-contain"
              />
            )}
          </span>
          <span className="truncate font-mono">{host}</span>
          {path && path !== '/' && (
            <span className="truncate text-muted-foreground/80">› {path}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Match strength mini-indicator */}
          <span
            className="hidden items-center gap-1.5 sm:inline-flex"
            title={`Match strength: ${strength}`}
          >
            <Progress
              value={strengthPct}
              className="h-1 w-12 bg-muted"
              aria-label={`Match strength: ${strength}`}
            />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {strength}
            </span>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label={`More options for result ${rank}`}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Result actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open source
                </a>
              </DropdownMenuItem>
              {onSummary && (
                <DropdownMenuItem
                  onClick={() => onSummary(result.id)}
                  className="flex items-center gap-2"
                >
                  <BookOpen className="size-3.5 text-gold" aria-hidden />
                  AI summary
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => openSourceProfile(result.id)}
                className="flex items-center gap-2"
              >
                <Info className="size-3.5" aria-hidden />
                Source profile
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setWhyOpen(true)}
                className="flex items-center gap-2"
              >
                <Check className="size-3.5 text-primary" aria-hidden />
                Why this result?
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onCopyLink}
                className="flex items-center gap-2"
              >
                {copied ? (
                  <Check className="size-3.5 text-primary" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                {copied ? 'Link copied' : 'Copy link'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Title (link) */}
      <h3 className="mt-1 text-base leading-snug sm:text-lg">
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
        >
          {result.title}
        </a>
      </h3>

      {/* URL breadcrumb */}
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-primary">
        <span className="font-mono truncate">
          {host}
          {path && path !== '/' ? path : ''}
        </span>
        <ExternalLink className="size-3" aria-hidden />
      </div>

      {/* Snippet with highlight */}
      <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">
        {highlightSnippet(truncateLines(result.snippet, 320), query).map((p, i) =>
          p.mark ? (
            <mark
              key={i}
              className="rounded-sm bg-primary/20 px-0.5 text-foreground"
            >
              {p.text}
            </mark>
          ) : (
            <React.Fragment key={i}>{p.text}</React.Fragment>
          ),
        )}
      </p>

      {/* Source DNA strip — a per-result "genetic fingerprint": 6 colored
          segments encoding source-type / country / language / quality /
          originality / freshness. At a glance, the user can see the unique
          algorithmic signature of each result. Re-colors smoothly when
          results re-rank (e.g. when switching to Devil's Advocate lens). */}
      <div className="mt-2">
        <SourceDna result={result} />
      </div>

      {/* Metadata row */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline" className={cn('text-[10px]', st.badge)}>
          {st.label}
        </Badge>
        {result.docType && (
          <Badge variant="outline" className="text-[10px]">
            <FileText className="size-2.5" aria-hidden />
            {result.docType}
          </Badge>
        )}
        {dateIso && (
          <span
            className="inline-flex items-center gap-1"
            title={formatShortDate(dateIso)}
          >
            <Calendar className="size-3" aria-hidden />
            {relDate}
          </span>
        )}
        {result.language && (
          <span className="inline-flex items-center gap-1">
            <Globe className="size-3" aria-hidden />
            {result.language.toUpperCase()}
          </span>
        )}
        {result.country && (
          <Badge variant="outline" className="text-[10px]">
            {result.country.toUpperCase()}
          </Badge>
        )}
        {result.isOriginal ? (
          <Badge
            variant="outline"
            className="text-[10px] border-primary/30 bg-primary/10 text-primary"
          >
            <Check className="size-2.5" aria-hidden />
            Original
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-[10px] border-slate-300 bg-slate-100 text-slate-700"
          >
            Duplicate
          </Badge>
        )}
        {result.author && (
          <span className="text-muted-foreground/80">· {result.author}</span>
        )}
      </div>

      {/* Cluster expansion */}
      {result.clusterSize > 1 && (
        <Collapsible
          open={clusterOpen}
          onOpenChange={setClusterOpen}
          className="mt-2"
        >
          <CollapsibleTrigger
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            aria-expanded={clusterOpen}
          >
            <Users className="size-3" aria-hidden />
            {clusterOpen ? 'Hide cluster' : `${result.clusterSize} more from this cluster`}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
            <p>
              {result.clusterSize - 1} near-duplicate
              {result.clusterSize - 1 === 1 ? '' : 's'} from {host} are
              collapsed here per the §12 diversity rule. We surface the
              original; the rest remain searchable via direct site queries.
            </p>
            <p className="mt-1 font-mono text-[10px]">
              Cluster ID: {result.clusterId ?? '—'}
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Why this result? */}
      <div className="mt-2">
        <Collapsible open={whyOpen} onOpenChange={setWhyOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-primary hover:bg-primary/10 hover:text-primary"
              aria-expanded={whyOpen}
              aria-label={`Why is this result shown for “${query}”?`}
            >
              <Info className="size-3" aria-hidden />
              Why this result?
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1">
            <WhyThisResult signals={result.whyThisResult} bare />
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Feedback row — 👍 / 👎 / Report. Always rendered (the buttons
          short-circuit + persist the user's vote in localStorage so the
          user can't vote twice on the same (query, docId) pair). */}
      <ResultFeedback
        query={query}
        docId={result.id}
        docUrl={result.url}
      />
    </motion.article>
  )
}

export default ResultCard
