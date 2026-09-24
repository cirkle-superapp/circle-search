/**
 * QueryDna.tsx
 * -----------------------------------------------------------------------------
 * A beautiful algorithmic introspection of the user's query. Renders the
 * parsed query as a "DNA card" — tokens, intent, entities, languages,
 * countries, plus a quick stats line at the bottom.
 *
 * Replaces the existing InterpretedQuery component (which only showed the
 * interpreted string + a few badges). The QueryDna card is a single glass
 * surface with a subtle gradient mesh border.
 *
 * Data sources (in priority order):
 *   1. `results.parsed` — the structured ParsedQuerySummary emitted by the
 *      server alongside the interpretedQuery string.
 *   2. Fallback: derive tokens from the raw query string + simple POS
 *      inference (capitalize first letter = noun, ends in "ing"/"ed" = verb,
 *      ends in "ful"/"ous"/"ive" = adjective). Intent is informational by
 *      default; entities/languages/countries are empty.
 *
 * Token chip colors (POS-inferred):
 *   noun       → teal
 *   verb       → rose
 *   adjective  → gold
 *   default    → steel (muted)
 *
 * Intent icons:
 *   informational  📚
 *   navigational   🧭
 *   transactional  💳
 *   news           📰
 *   research       🔬
 *
 * Entity icons (lucide): PERSON 👤, ORGANIZATION 🏢, PLACE 📍, etc.
 *
 * Spring entrance: opacity 0→1, y 8→0, duration 0.4s.
 *
 * The card has a subtle animated gradient border via the `bg-gradient-mesh`
 * class wrapped at low opacity behind the glass surface.
 */

'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  BookOpen,
  Compass,
  CreditCard,
  Newspaper,
  Microscope,
  Search as SearchIcon,
  User,
  Building2,
  MapPin,
  Calendar,
  Hash,
  type LucideIcon,
} from 'lucide-react'
import { useSearchStore } from '@/store/search-store'
import { cn } from '@/lib/utils'
import type { ParsedQuerySummary } from './types'

// --- POS inference (heuristic — no real POS tagger) -----------------------

/** Map a single token to an inferred POS tag. Used to color the token chip. */
function inferPos(token: string): 'noun' | 'verb' | 'adjective' | 'default' {
  const t = token.toLowerCase()
  if (!t) return 'default'
  // Verb heuristic: ends in -ing / -ed / -s (present participle / past / 3rd-person)
  if (/(ing|ed)$/.test(t) && t.length > 4) return 'verb'
  if (/ies$/.test(t) && t.length > 4) return 'verb' // "studies", "carries"
  // Adjective heuristic: -ful, -ous, -ive, -able, -ible, -al, -ic
  if (/(ful|ous|ive|able|ible|al|ic)$/.test(t) && t.length > 4) return 'adjective'
  // Otherwise assume noun (proper-noun if capitalized, common noun otherwise).
  return 'noun'
}

/** POS → Tailwind text/bg color classes (pill background). */
const POS_STYLES: Record<
  ReturnType<typeof inferPos>,
  { chip: string }
> = {
  noun: {
    chip: 'bg-teal/15 text-teal border-teal/30',
  },
  verb: {
    chip: 'bg-rose/15 text-rose border-rose/30',
  },
  adjective: {
    chip: 'bg-gold/20 text-gold border-gold/40',
  },
  default: {
    chip: 'bg-steel/15 text-steel border-steel/30',
  },
}

// --- Intent metadata -----------------------------------------------------

const INTENT_META: Record<string, { icon: LucideIcon; label: string }> = {
  informational: { icon: BookOpen, label: 'informational' },
  navigational: { icon: Compass, label: 'navigational' },
  transactional: { icon: CreditCard, label: 'transactional' },
  news: { icon: Newspaper, label: 'news' },
  research: { icon: Microscope, label: 'research' },
  // Defensive defaults for the other 7 intent categories emitted by the
  // backend (commercial / local / academic / document / entity / media /
  // comparison). They all fall back to informational iconography.
  commercial: { icon: CreditCard, label: 'commercial' },
  local: { icon: MapPin, label: 'local' },
  academic: { icon: Microscope, label: 'academic' },
  document: { icon: BookOpen, label: 'document' },
  entity: { icon: SearchIcon, label: 'entity' },
  media: { icon: SearchIcon, label: 'media' },
  comparison: { icon: Compass, label: 'comparison' },
}

function intentMeta(intent: string | undefined): { icon: LucideIcon; label: string } {
  if (!intent) return INTENT_META.informational
  return INTENT_META[intent] ?? INTENT_META.informational
}

// --- Entity icons -------------------------------------------------------

const ENTITY_ICONS: Record<string, LucideIcon> = {
  PERSON: User,
  ORGANIZATION: Building2,
  PLACE: MapPin,
  LOCATION: MapPin,
  DATE: Calendar,
  EVENT: Calendar,
  TOPIC: Hash,
  CONCEPT: Hash,
}

function entityIcon(type: string | undefined): LucideIcon {
  if (!type) return Hash
  return ENTITY_ICONS[type.toUpperCase()] ?? Hash
}

// --- Language flag emoji map -------------------------------------------

const LANGUAGE_FLAGS: Record<string, string> = {
  en: '🇬🇧',
  ar: '🇸🇦',
  fr: '🇫🇷',
  de: '🇩🇪',
  es: '🇪🇸',
  it: '🇮🇹',
  pt: '🇵🇹',
  ru: '🇷🇺',
  zh: '🇨🇳',
  ja: '🇯🇵',
  ko: '🇰🇷',
  hi: '🇮🇳',
  tr: '🇹🇷',
  nl: '🇳🇱',
  sv: '🇸🇪',
  pl: '🇵🇱',
  he: '🇮🇱',
}

function languageFlag(code: string | undefined): string {
  if (!code) return '🌐'
  const c = code.toLowerCase().split('-')[0] ?? code.toLowerCase()
  return LANGUAGE_FLAGS[c] ?? '🌐'
}

// --- Country flag emoji map (subset) — keep short, fall back to 🌍 ----

const COUNTRY_FLAGS: Record<string, string> = {
  US: '🇺🇸',
  GB: '🇬🇧',
  UK: '🇬🇧',
  FR: '🇫🇷',
  DE: '🇩🇪',
  ES: '🇪🇸',
  IT: '🇮🇹',
  PT: '🇵🇹',
  RU: '🇷🇺',
  CN: '🇨🇳',
  JP: '🇯🇵',
  KR: '🇰🇷',
  IN: '🇮🇳',
  BR: '🇧🇷',
  CA: '🇨🇦',
  AU: '🇦🇺',
  AE: '🇦🇪',
  SA: '🇸🇦',
  EG: '🇪🇬',
  IL: '🇮🇱',
  NL: '🇳🇱',
  SE: '🇸🇪',
  CH: '🇨🇭',
  MX: '🇲🇽',
  ZA: '🇿🇦',
}

function countryFlag(code: string | undefined): string {
  if (!code) return '🌍'
  return COUNTRY_FLAGS[code.toUpperCase()] ?? '🌍'
}

// --- Helpers ------------------------------------------------------------

/** Tokenize the raw query string when no parsed.tokens is available. */
function tokenizeFallback(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'))
    .map((t) => t.replace(/^["']|["']$/g, ''))
}

/** Derive a ParsedQuerySummary from the raw query string. */
function deriveFromQuery(query: string): ParsedQuerySummary {
  const tokens = tokenizeFallback(query)
  // Best-effort intent inference on the client (mirrors the backend rules
  // in `src/lib/search/query-understanding.ts`).
  const lower = query.toLowerCase()
  let intent = 'informational'
  if (/\bnear me\b/.test(lower) || /\bin\s+[a-z]+\b/i.test(lower)) intent = 'local'
  else if (/(buy|price|cheap|deal|discount|sale|shop|order|best price)/.test(lower)) intent = 'commercial'
  else if (/(download|sign up|register|subscribe|install|join|apply|book|reserve)/.test(lower)) intent = 'transactional'
  else if (/(news|today|latest|breaking|update|press|announced|report)/.test(lower)) intent = 'news'
  else if (/(research|study|studies|paper|papers|arxiv|journal|academic|scholar|evidence|analysis|data|statistics)/.test(lower)) intent = 'research'
  else if (/(how|what|why|who|when|explain|guide|tutorial|examples|definition)/.test(lower)) intent = 'informational'
  else if (/(vs|versus|compare|comparison|or\b|better|alternative)/.test(lower)) intent = 'comparison'
  else if (/(image|images|picture|photo|video|movie|clip)/.test(lower)) intent = 'media'
  else if (/(pdf|docs|documentation|manual|reference|spec|specification)/.test(lower)) intent = 'document'

  return {
    tokens,
    phrases: [],
    exclusions: query
      .split(/\s+/)
      .filter((t) => t.startsWith('-'))
      .map((t) => t.slice(1)),
    intent,
    entities: [],
    languages: [],
    countries: [],
  }
}

// --- Component ----------------------------------------------------------

export interface QueryDnaProps {
  className?: string
}

export function QueryDna({ className }: QueryDnaProps) {
  const results = useSearchStore((s) => s.results)
  const query = useSearchStore((s) => s.query)

  // Pick the parsed summary: prefer server-emitted, else derive from raw query.
  const parsed: ParsedQuerySummary | null = React.useMemo(() => {
    if (results?.parsed && results.parsed.tokens.length > 0) return results.parsed
    if (query && query.trim()) return deriveFromQuery(query)
    return null
  }, [results?.parsed, query])

  if (!parsed || parsed.tokens.length === 0) return null

  const intent = intentMeta(parsed.intent)
  const IntentIcon = intent.icon
  const uniqueTokens = new Set(parsed.tokens.map((t) => t.toLowerCase()))

  return (
    <motion.section
      aria-label="Query DNA"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'relative w-full max-w-3xl overflow-hidden rounded-xl',
        'glass shadow-glass',
        // Subtle gradient mesh border (the ::before element creates a 1px ring).
        className,
      )}
    >
      {/* Gradient mesh border — a conic gradient ring behind the glass
          surface. Pointer-events-none so it never blocks clicks. Opacity
          is set low so it stays subtle. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 rounded-xl opacity-20 blur-md bg-gradient-mesh"
      />

      <div className="px-4 py-3 sm:px-5 sm:py-4">
        {/* Header */}
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-foreground/80">
            <SearchIcon className="size-3.5 text-gold" aria-hidden />
            Query DNA
          </span>
        </div>

        {/* Tokens */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tokens
          </span>
          {parsed.tokens.map((token, i) => {
            const pos = inferPos(token)
            const posStyle = POS_STYLES[pos]
            return (
              <span
                key={`${token}-${i}`}
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5',
                  'font-mono text-xs',
                  posStyle.chip,
                )}
              >
                {token}
              </span>
            )
          })}
        </div>

        {/* Intent + Entities */}
        <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Intent
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
              <IntentIcon className="size-3" aria-hidden />
              {intent.label}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Entities
            </span>
            {parsed.entities.length === 0 ? (
              <span className="text-muted-foreground/70">(none detected)</span>
            ) : (
              parsed.entities.slice(0, 4).map((e, i) => {
                const EIcon = entityIcon(e.type)
                return (
                  <span
                    key={`${e.text}-${i}`}
                    className="inline-flex items-center gap-1 rounded-full bg-teal/10 px-2 py-0.5 text-teal"
                  >
                    <EIcon className="size-3" aria-hidden />
                    {e.text}
                    {e.type && (
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                        {e.type}
                      </span>
                    )}
                  </span>
                )
              })
            )}
          </div>
        </div>

        {/* Languages + Countries */}
        <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Languages
            </span>
            {parsed.languages.length === 0 ? (
              <span className="text-muted-foreground/70">🌐 (auto-detected by CIRKLE)</span>
            ) : (
              parsed.languages.map((lang, i) => (
                <span
                  key={`lang-${lang}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full bg-steel/10 px-2 py-0.5 text-steel"
                >
                  <span aria-hidden>{languageFlag(lang)}</span>
                  {lang.toUpperCase()}
                </span>
              ))
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Countries
            </span>
            {parsed.countries.length === 0 ? (
              <span className="text-muted-foreground/70">🌍 (none detected)</span>
            ) : (
              parsed.countries.map((c, i) => (
                <span
                  key={`country-${c}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full bg-rose/10 px-2 py-0.5 text-rose"
                >
                  <span aria-hidden>{countryFlag(c)}</span>
                  {c.toUpperCase()}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Stats line */}
        <div className="mt-3 border-t border-border/40 pt-2 text-[10px] text-muted-foreground">
          <span className="font-mono">{parsed.tokens.length}</span> tokens ·{' '}
          <span className="font-mono">{uniqueTokens.size}</span> unique ·{' '}
          <span className="font-mono">{parsed.phrases.length}</span> phrases ·{' '}
          <span className="font-mono">{parsed.exclusions.length}</span> exclusions
        </div>
      </div>
    </motion.section>
  )
}

export default QueryDna
