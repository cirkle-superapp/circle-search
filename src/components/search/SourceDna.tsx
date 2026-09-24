/**
 * SourceDna.tsx
 * -----------------------------------------------------------------------------
 * A per-result visual "DNA strip" — a horizontal bar with 6 colored segments,
 * each representing a different dimension of the source.
 *
 *   Source Type  25% — colored by source-type (NEWS=rose, ACADEMIC=steel, etc.)
 *   Country      10% — country flag color or default muted
 *   Language     10% — language-typical color (en=teal, ar=gold, etc.)
 *   Quality      20% — gradient red→yellow→green based on qualityScore (0..1)
 *   Originality  15% — bg-primary if isOriginal, bg-slate-400 if duplicate
 *   Freshness    20% — gradient gray (old)→teal (recent) based on dates
 *
 * The strip feels like a "genetic fingerprint" — at a glance, the user sees
 * the unique algorithmic signature of each result.
 *
 * Each segment: 100% height of the 6px bar, transition-all duration-500 for
 * smooth color changes when results re-rank (e.g. when the user switches
 * to the Devil's Advocate lens). Rounded ends. Subtle hover scale-up (1.1x)
 * via the .group-card-hover utility. shadcn Tooltip for the hover text.
 */

'use client'

import * as React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { sourceTypeStyle } from './source-type'
import { formatRelativeTime } from './format'
import { cn } from '@/lib/utils'
import type { SearchResult } from './types'

/**
 * Compute a freshness score (0..1): 1 = just crawled/updated, 0 = stale.
 * Mirrors the ranking's freshness curve (90d → 1.0, 365d → 0.6, else 0.3).
 */
function freshnessScore(result: SearchResult): number {
  const refIso = result.updatedAt ?? result.publishedAt
  if (!refIso) {
    // Fall back to crawledAt — but we don't have crawledAt on the client
    // SearchResult (it's on the server DocRow, not exposed to the client).
    // Treat as "moderately recent".
    return 0.5
  }
  const then = new Date(refIso).getTime()
  if (Number.isNaN(then)) return 0.5
  const days = (Date.now() - then) / (1000 * 60 * 60 * 24)
  if (days <= 90) return 1.0
  if (days <= 365) return 0.6
  return 0.3
}

/** Quality score → HSL color gradient: 0=red, 0.5=yellow, 1=green. */
function qualityColor(score: number): string {
  const s = Math.max(0, Math.min(1, score))
  // Map [0, 0.5] → red→yellow (hue 0→55), [0.5, 1] → yellow→green (hue 55→135)
  const hue = s < 0.5 ? (s / 0.5) * 55 : 55 + ((s - 0.5) / 0.5) * (135 - 55)
  const sat = 65
  const light = 50
  return `hsl(${hue} ${sat}% ${light}%)`
}

/** Freshness score → HSL color gradient: 0=gray, 1=teal. */
function freshnessColor(score: number): string {
  const s = Math.max(0, Math.min(1, score))
  // Lerp from muted gray (220, 8%, 50%) at 0 to brand teal (195, 56%, 33%) at 1
  const hue = 220 + (195 - 220) * s
  const sat = 8 + (56 - 8) * s
  const light = 50 + (33 - 50) * s
  return `hsl(${hue} ${sat}% ${light}%)`
}

/**
 * Map an ISO 3166-1 alpha-2 country code to a representative flag color.
 * Picks a recognizable national color (red for US/JPN/CHN/etc., blue for
 * FRA/UN, etc.). Falls back to a neutral muted color.
 */
const COUNTRY_COLORS: Record<string, string> = {
  US: 'hsl(0 78% 50%)',     // red (US flag's stripes)
  GB: 'hsl(220 70% 50%)',  // blue (Union Jack)
  UK: 'hsl(220 70% 50%)',
  FR: 'hsl(220 85% 50%)',  // blue
  DE: 'hsl(0 0% 30%)',     // black (German flag)
  JP: 'hsl(0 78% 50%)',    // red (Hinomaru)
  CN: 'hsl(0 78% 50%)',    // red
  CN_HK: 'hsl(0 78% 50%)',
  IN: 'hsl(30 80% 50%)',    // saffron
  BR: 'hsl(120 60% 40%)',  // green
  CA: 'hsl(0 78% 50%)',    // red (Canadian flag)
  AU: 'hsl(220 70% 45%)',  // blue
  AE: 'hsl(120 60% 40%)',  // green (UAE flag)
  SA: 'hsl(120 60% 40%)',  // green (Saudi flag)
  EG: 'hsl(120 60% 40%)',  // green
  IL: 'hsl(220 80% 50%)',  // blue
  RU: 'hsl(0 78% 50%)',    // red
  IT: 'hsl(120 60% 40%)',  // green
  ES: 'hsl(0 78% 50%)',    // red/yellow — pick red
  NL: 'hsl(0 78% 50%)',    // orange-red
  SE: 'hsl(220 80% 50%)',  // blue
  CH: 'hsl(0 78% 50%)',    // red (Swiss flag)
  MX: 'hsl(120 60% 40%)',  // green
  KR: 'hsl(220 80% 50%)',  // blue
  ZA: 'hsl(120 60% 40%)',  // green
}

function countryColor(code: string | null | undefined): string {
  if (!code) return 'hsl(220 8% 50%)'
  return COUNTRY_COLORS[code.toUpperCase()] ?? 'hsl(220 8% 50%)'
}

/**
 * Language → color map. Picks a recognizable cultural color (en=teal,
 * ar=gold, etc.). Falls back to a muted steel for unknown languages.
 */
const LANGUAGE_COLORS: Record<string, string> = {
  en: 'hsl(195 56% 33%)',  // teal (CIRKLE primary)
  ar: 'hsl(39 45% 57%)',   // gold
  fr: 'hsl(220 70% 50%)',  // blue
  de: 'hsl(0 0% 30%)',     // black
  es: 'hsl(0 78% 50%)',    // red
  it: 'hsl(120 60% 40%)',  // green
  pt: 'hsl(120 60% 40%)',  // green
  ru: 'hsl(0 78% 50%)',    // red
  zh: 'hsl(0 78% 50%)',    // red
  ja: 'hsl(0 78% 50%)',    // red
  ko: 'hsl(220 80% 50%)',  // blue
  hi: 'hsl(30 80% 50%)',   // saffron
  tr: 'hsl(0 78% 50%)',    // red
  nl: 'hsl(35 85% 55%)',   // orange
  sv: 'hsl(220 80% 50%)',  // blue
  pl: 'hsl(0 78% 50%)',    // red
  he: 'hsl(220 80% 50%)',  // blue
}

function languageColor(code: string | null | undefined): string {
  if (!code) return 'hsl(211 30% 50%)' // steel
  const c = code.toLowerCase()
  // Handle 2-char + extended codes (e.g. "en-US" → "en")
  const base = c.split('-')[0] ?? c
  return LANGUAGE_COLORS[base] ?? 'hsl(211 30% 50%)'
}

interface SourceDnaSegment {
  /** Tailwind width class. */
  widthClass: string
  /** Inline CSS background — gradient or solid color. */
  background: string
  /** Tooltip text shown on hover. */
  tooltip: string
  /** Aria label for screen readers (segment is decorative, but if the user
   *  navigates via keyboard to the strip, each segment gets a label). */
  ariaLabel: string
}

export interface SourceDnaProps {
  result: SearchResult
  className?: string
}

export function SourceDna({ result, className }: SourceDnaProps) {
  const st = sourceTypeStyle(result.sourceType)
  // sourceTypeStyle returns a `favicon` Tailwind class like "bg-rose" — we
  // need a real CSS color, so map known source-type names to HSL values.
  // (Mirrors the @theme tokens in globals.css.)
  const SOURCE_TYPE_COLOR: Record<string, string> = {
    OFFICIAL: 'hsl(195 56% 33%)',  // teal
    GOVERNMENT: 'hsl(60 8% 25%)',  // charcoal-ish
    ACADEMIC: 'hsl(211 30% 42%)',  // steel
    NEWS: 'hsl(351 41% 56%)',      // rose
    COMMUNITY: 'hsl(39 45% 57%)',  // gold
    COMMERCIAL: 'hsl(39 45% 57%)', // gold
    PRIMARY: 'hsl(195 56% 33%)',    // teal
    WEB: 'hsl(60 6% 45%)',          // muted
  }
  const sourceColor = SOURCE_TYPE_COLOR[result.sourceType] ?? 'hsl(60 6% 45%)'
  const quality = result.qualityScore ?? 0
  const freshness = freshnessScore(result)
  const refDateIso = result.updatedAt ?? result.publishedAt

  const segments: SourceDnaSegment[] = [
    {
      widthClass: 'w-[25%]',
      background: sourceColor,
      tooltip: `Source: ${result.sourceType}`,
      ariaLabel: `Source type ${result.sourceType}`,
    },
    {
      widthClass: 'w-[10%]',
      background: countryColor(result.country),
      tooltip: result.country
        ? `Country: ${result.country.toUpperCase()}`
        : 'Country: (none detected)',
      ariaLabel: `Country ${result.country ?? 'none'}`,
    },
    {
      widthClass: 'w-[10%]',
      background: languageColor(result.language),
      tooltip: result.language
        ? `Language: ${result.language.toUpperCase()}`
        : 'Language: (unknown)',
      ariaLabel: `Language ${result.language ?? 'unknown'}`,
    },
    {
      widthClass: 'w-[20%]',
      background: qualityColor(quality),
      tooltip: `Quality: ${quality.toFixed(2)}`,
      ariaLabel: `Quality score ${quality.toFixed(2)}`,
    },
    {
      widthClass: 'w-[15%]',
      background: result.isOriginal
        ? 'hsl(195 56% 33%)' // teal — bg-primary
        : 'hsl(220 8% 60%)',  // slate-400-ish
      tooltip: result.isOriginal ? 'Original source' : 'Duplicate',
      ariaLabel: result.isOriginal ? 'Original source' : 'Duplicate',
    },
    {
      widthClass: 'w-[20%]',
      background: freshnessColor(freshness),
      tooltip: refDateIso
        ? `${result.updatedAt ? 'Updated' : 'Published'} ${formatRelativeTime(refDateIso)}`
        : 'Date: (unknown)',
      ariaLabel: refDateIso
        ? `Date ${formatRelativeTime(refDateIso)}`
        : 'Date unknown',
    },
  ]

  return (
    <div
      className={cn(
        // The DNA strip — a 100px-wide, 6px-tall horizontal bar. Each
        // segment fills its share of the width; rounded ends.
        'flex h-[6px] w-[100px] overflow-hidden rounded-full',
        'border border-border/40 bg-muted/30',
        // When the parent card re-ranks (key change), this strip smoothly
        // re-colors rather than snapping.
        className,
      )}
      role="img"
      aria-label={`Source DNA: ${segments.map((s) => s.ariaLabel).join(', ')}`}
    >
      {segments.map((seg, i) => (
        <Tooltip key={i}>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'block h-full cursor-help transition-all duration-500 ease-out',
                'hover:scale-y-[1.4] hover:z-10',
                seg.widthClass,
              )}
              style={{
                backgroundColor: seg.background,
                transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
              }}
              aria-hidden
            />
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="text-center text-xs"
            sideOffset={4}
          >
            {seg.tooltip}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

export default SourceDna
