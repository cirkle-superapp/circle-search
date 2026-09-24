/**
 * KnowledgeSidebar.tsx
 * -----------------------------------------------------------------------------
 * Desktop-only sticky sidebar (renders at ≥1024px / lg breakpoint) that wraps
 * the knowledge card so it stays visible while the user scrolls through
 * organic results. On mobile / tablet, callers should render the plain
 * <KnowledgeCard> inline at the top of the results list (the sidebar
 * component is hidden below lg via `hidden lg:block`).
 *
 * Visual treatment:
 *   - Glass morphism (.glass) + shadow-glass for a premium floating panel
 *   - max-width 320px so it doesn't dominate the right column
 *   - sticky top-20 so it tracks the user's scroll position
 *   - subtle gold top accent border (the CIRKLE brand mark)
 */

'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { KnowledgeCard } from './KnowledgeCard'
import type { KnowledgeCard as KnowledgeCardData } from './types'

export interface KnowledgeSidebarProps {
  card: KnowledgeCardData
  className?: string
}

export function KnowledgeSidebar({ card, className }: KnowledgeSidebarProps) {
  return (
    <div
      className={cn(
        // Sticky behavior: the sidebar follows the user down the page.
        // top-20 keeps it below the sticky SearchHeader (which is ~64px).
        'lg:sticky lg:top-20 lg:self-start',
        // Width cap so the sidebar doesn't dominate the right column.
        'w-full max-w-[320px]',
        className,
      )}
      aria-label="Knowledge sidebar"
    >
      {/* Glass wrapper: gives the sidebar the premium CIRKLE feel even
          though the inner KnowledgeCard is already a Card. The gold top
          accent strip matches the brand mark. */}
      <div className="glass relative overflow-hidden rounded-2xl shadow-glass">
        {/* Gold accent strip — the CIRKLE brand signature on glass
            surfaces. */}
        <div
          className="absolute inset-x-0 top-0 h-0.5 bg-gradient-gold"
          aria-hidden
        />
        <div className="pt-0.5">
          <KnowledgeCard card={card} />
        </div>
      </div>
    </div>
  )
}

export default KnowledgeSidebar
