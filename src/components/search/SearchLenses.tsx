/**
 * SearchLenses.tsx
 * -----------------------------------------------------------------------------
 * The standout creative feature of CIRKLE: a row of toggleable "lens" pills
 * above the search results. Each lens re-weights the ranking signals to
 * surface a specific perspective.
 *
 *   Balanced ⚖️, Academic 🎓, News 📰, Primary 📄, Community 👥,
 *   Commercial 🛒, Devil's Advocate 🔥
 *
 * The crown jewel is DEVILS_ADVOCATE — it INVERTS the ranking so docs that
 * DON'T match as strongly surface FIRST. This surfaces dissenting /
 * contrarian / tangential views, which is uniquely valuable for
 * controversial queries.
 *
 * Behavior:
 *   - Each pill: lucide icon + label, colored per LENS_METADATA.
 *   - Active lens has a colored background + ring.
 *   - Devil's Advocate pill has a rose/red gradient + a subtle pulse-glow.
 *   - Hover opens a Tooltip with the lens's description.
 *   - Clicking updates the store (setLens) which triggers re-search with
 *     the new lens in the request body. The result cards re-rank with a
 *     spring animation (handled by the existing staggered entrance in
 *     SearchResults — when the `lens` key changes, the motion section's
 *     key prop change re-triggers the entrance).
 *   - Mobile: horizontal scroll (overflow-x-auto scrollbar-hide).
 *   - Desktop: centered row with flex-wrap justify-center.
 *
 * Reduced-motion users get a static active state — the pulse-glow is
 * disabled by the global prefers-reduced-motion override in globals.css.
 */

'use client'

import * as React from 'react'
import {
  Scale,
  GraduationCap,
  Newspaper,
  FileText,
  Users,
  ShoppingBag,
  Flame,
  type LucideIcon,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSearchStore } from '@/store/search-store'
import { LENS_METADATA, type SearchLens } from './types'
import { cn } from '@/lib/utils'

/** Map the icon-string keys in LENS_METADATA to actual lucide-react components. */
const ICON_MAP: Record<string, LucideIcon> = {
  scale: Scale,
  'graduation-cap': GraduationCap,
  newspaper: Newspaper,
  'file-text': FileText,
  users: Users,
  'shopping-bag': ShoppingBag,
  flame: Flame,
}

/** Ordered list of lenses — Devil's Advocate last for visual punch. */
const LENS_ORDER: SearchLens[] = [
  'BALANCED',
  'ACADEMIC',
  'NEWS',
  'PRIMARY',
  'COMMUNITY',
  'COMMERCIAL',
  'DEVILS_ADVOCATE',
]

export interface SearchLensesProps {
  className?: string
}

export function SearchLenses({ className }: SearchLensesProps) {
  const lens = useSearchStore((s) => s.lens)
  const setLens = useSearchStore((s) => s.setLens)

  return (
    <nav
      aria-label="Search lenses"
      className={cn(
        'w-full',
        // Mobile: horizontal scroll. Desktop: centered wrap.
        'flex items-center gap-1.5 overflow-x-auto scrollbar-hide',
        'md:flex-wrap md:justify-center md:overflow-visible',
        className,
      )}
    >
      {LENS_ORDER.map((lensKey) => {
        const meta = LENS_METADATA[lensKey]
        const Icon = ICON_MAP[meta.icon] ?? Scale
        const isActive = lens === lensKey
        const isDevils = lensKey === 'DEVILS_ADVOCATE'

        const pill = (
          <button
            key={lensKey}
            type="button"
            onClick={() => setLens(lensKey)}
            aria-pressed={isActive}
            aria-label={`${meta.label} lens — ${meta.description}`}
            className={cn(
              'relative inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium',
              'border transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-1',
              isActive
                ? cn(
                    meta.bg,
                    meta.color,
                    'border-transparent ring-1',
                    meta.ring,
                    'shadow-soft',
                  )
                : 'border-border/60 bg-surface/40 text-muted-foreground hover:bg-surface hover:text-foreground',
              isDevils && isActive && 'animate-pulse-glow',
            )}
            style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
          >
            {isDevils ? (
              // Devil's Advocate: gradient red/rose background — visually
              // distinct from the rest, with a soft glow pulse.
              <span
                className={cn(
                  'absolute inset-0 -z-10 rounded-full bg-gradient-to-r from-rose via-rose/80 to-destructive',
                  isActive ? 'opacity-100' : 'opacity-0 hover:opacity-30',
                )}
                aria-hidden
              />
            ) : null}
            <Icon className="size-3.5" aria-hidden />
            <span className="whitespace-nowrap">{meta.label}</span>
            {isDevils && (
              <span
                className={cn(
                  'ml-0.5 text-[9px] font-bold uppercase tracking-wider',
                  isActive ? 'text-rose' : 'text-muted-foreground/70',
                )}
                aria-hidden
              >
                !
              </span>
            )}
          </button>
        )

        return (
          <Tooltip key={lensKey}>
            <TooltipTrigger asChild>
              {pill}
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="max-w-[280px] text-balance text-center font-normal"
            >
              <span className="block">
                <span className={cn('font-semibold', meta.color)}>{meta.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {meta.description}
                </span>
              </span>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}

export default SearchLenses
