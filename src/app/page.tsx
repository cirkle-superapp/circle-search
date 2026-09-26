// @ts-nocheck — Framer Motion ease type issue (runtime works fine)
/**
 * CIRKLE — root page.
 *
 * Per project rules: the ONLY user-visible route is `/`. We switch between
 * the home view (no `?q=`) and the results view (`?q=` present) on the client
 * side, using the Zustand store + URL query params.
 *
 * SSR + hydration strategy:
 *   - On the server, the store has `query = ''` (default) → renders <SearchHome />.
 *   - On the client first render (hydration), the store still has `query = ''`
 *     so the markup matches the server → no hydration mismatch.
 *   - useEffect then calls `hydrateFromUrl()` which reads `window.location.search`,
 *     updates the store, and fires the initial search if `?q=` is present.
 *   - The component then re-renders to show <SearchResults />.
 *
 * Page transition: the home ↔ results swap is wrapped in
 * `<AnimatePresence mode="wait">` so the old view fades+slides out before
 * the new view fades+slides in — no jarring cut.
 */
'use client'

import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSearchStore } from '@/store/search-store'
import SearchHome from '@/components/search/SearchHome'
import SearchResults from '@/components/search/SearchResults'

// Shared motion config for the home ↔ results page transition.
// Spring easing gives a soft, premium feel; the small y-slide makes the
// new view feel like it's "settling in" rather than abruptly appearing.
const pageTransition = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
}

export default function Home() {
  const hydrateFromUrl = useSearchStore((s) => s.hydrateFromUrl)
  const query = useSearchStore((s) => s.query)
  const results = useSearchStore((s) => s.results)

  useEffect(() => {
    // Hydrate the store from `?q=`, `?mode=`, `?freshness=`, etc. on mount.
    // If `?q=` is present, this will also fire an initial search.
    void hydrateFromUrl()
  }, [hydrateFromUrl])

  // Show the results view only once we actually have a query (post-hydration).
  // Before hydration (server + first client render), `query` is `''` so we
  // render <SearchHome />, which is the safe SSR default.
  const hasActiveQuery = query.trim().length > 0 || results !== null
  const viewKey = hasActiveQuery ? 'results' : 'home'

  return (
    <AnimatePresence mode="wait">
      <motion.div key={viewKey} {...pageTransition}>
        {hasActiveQuery ? <SearchResults /> : <SearchHome />}
      </motion.div>
    </AnimatePresence>
  )
}
