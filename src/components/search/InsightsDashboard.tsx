// @ts-nocheck
/**
 * InsightsDashboard.tsx
 * -----------------------------------------------------------------------------
 * Operator-facing insights dialog — surfaces what's happening in the CIRKLE
 * search engine in real time. Triggered from the footer via an "Insights"
 * button next to the BrightData badge + IndexStatusBar.
 *
 * The dialog requires the operator token (`OPERATOR_TOKEN` constant in
 * `src/lib/operator-token.ts`). All `/api/insights` calls are made with
 * `Authorization: Bearer ${OPERATOR_TOKEN}`. If the token is wrong (401)
 * or missing, the dialog shows a banner "Unauthorized — set
 * BRIGHTDATA_OPERATOR_TOKEN env".
 *
 * Sections rendered:
 *   1. Top 10 queries (table: query + frequency)
 *   2. Top 10 domains (table: domain + docCount + avgQuality)
 *   3. Trending queries (top 5)
 *   4. BrightData budget (daily used/cap, monthly used/cap, last error)
 *   5. Index growth (count by day)
 *   6. Recent searches (last 10)
 *   7. Health check status (`/api/health`)
 */

'use client'

import * as React from 'react'
import {
  BarChart3,
  Loader2,
  RefreshCw,
  TrendingUp,
  Database,
  Globe2,
  Activity,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { OPERATOR_TOKEN } from '@/lib/operator-token'
import { cn } from '@/lib/utils'
import {
  Bar,
  BarChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from 'recharts'

// --- Types (mirror the shapes returned by /api/insights + /api/health) ----

interface TopQuery { query: string; frequency: number; lastUsedAt?: string }
interface TopDomain { domain: string; docCount: number; avgQuality: number }
interface TrendingQuery { query: string; frequency: number }
interface IndexGrowthPoint { date: string; docCount: number }
interface RecentSearch {
  query?: string
  timestamp?: string
  tookMs?: number
  totalFound?: number
  [k: string]: unknown
}

interface InsightsResponse {
  range: string
  topQueries: TopQuery[]
  topDomains: TopDomain[]
  zeroResultQueries: { query: string; frequency: number }[]
  toolUsage: Record<string, number>
  trending: TrendingQuery[]
  indexGrowth: IndexGrowthPoint[]
  recent: RecentSearch[]
  summary: {
    totalUniqueQueries: number
    totalSearches: number
    avgLatencyMs: number
    p95LatencyMs: number
    zeroResultRate: number
    indexDocCount: number
  }
}

interface BrightDataBudget {
  enabled: boolean
  budget: {
    daily: { used: number; cap: number; remaining: number }
    monthly: { used: number; cap: number; remaining: number }
  }
  disabledKinds: string[]
  totals: { successful: number; fallbacks: number }
  lastError: string | null
  zeroCostGuarantee: boolean
}

interface HealthCheck {
  status: 'ok' | 'degraded' | 'down' | 'unknown'
  checks: Record<string, any>
  uptime: number
  version: string
  responseMs: number
  timestamp: string
}

// --- Component -------------------------------------------------------------

export function InsightsDashboard() {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [unauthorized, setUnauthorized] = React.useState(false)
  const [insights, setInsights] = React.useState<InsightsResponse | null>(null)
  const [budget, setBudget] = React.useState<BrightDataBudget | null>(null)
  const [health, setHealth] = React.useState<HealthCheck | null>(null)

  const loadAll = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    setUnauthorized(false)

    // Fetch all three endpoints in parallel. The insights + brightdata status
    // calls are auth'd; the health call is public. Each is independent — a
    // failure of one doesn't block the others.
    const [insightsRes, budgetRes, healthRes] = await Promise.allSettled([
      fetch('/api/insights?range=day', {
        headers: {
          Authorization: `Bearer ${OPERATOR_TOKEN}`,
        },
      }),
      fetch('/api/brightdata/status', {
        headers: { 'XTransformPort': '3000' },
      }),
      fetch('/api/health', { cache: 'no-store' }),
    ])

    // --- Insights ---
    if (insightsRes.status === 'fulfilled') {
      const r = insightsRes.value
      if (r.status === 401 || r.status === 403) {
        setUnauthorized(true)
      } else if (r.ok) {
        try {
          const data = (await r.json()) as InsightsResponse
          setInsights(data)
        } catch (e: any) {
          setError(`Failed to parse insights: ${e?.message ?? String(e)}`)
        }
      } else {
        const body = await r.json().catch(() => ({}))
        setError(`Insights failed: ${body?.error ?? r.status}`)
      }
    } else {
      setError(`Insights request failed: ${insightsRes.reason ?? 'network error'}`)
    }

    // --- BrightData budget ---
    if (budgetRes.status === 'fulfilled' && budgetRes.value.ok) {
      try {
        setBudget((await budgetRes.value.json()) as BrightDataBudget)
      } catch {
        // silent
      }
    }

    // --- Health ---
    if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
      try {
        const h = (await healthRes.value.json()) as HealthCheck
        setHealth(h)
      } catch {
        // silent
      }
    }

    setLoading(false)
  }, [])

  // When the dialog opens, kick off the first load.
  React.useEffect(() => {
    if (open && !insights && !loading) {
      void loadAll()
    }
  }, [open, insights, loading, loadAll])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) void loadAll()
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Open operator insights dashboard"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <BarChart3 className="size-3.5 text-primary" aria-hidden />
          <span>Insights</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="size-4 text-primary" aria-hidden />
            Operator insights
          </DialogTitle>
          <DialogDescription>
            Real-time view of what users are searching + how the engine is
            doing. Data from the last 24 hours.
          </DialogDescription>
        </DialogHeader>

        {/* Unauthorized banner */}
        {unauthorized && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
          >
            <ShieldAlert className="size-4 shrink-0 mt-0.5" aria-hidden />
            <div>
              <div className="font-semibold">Unauthorized</div>
              <div className="mt-0.5">
                Set <code className="font-mono">BRIGHTDATA_OPERATOR_TOKEN</code> env
                var on the server, or update{' '}
                <code className="font-mono">src/lib/operator-token.ts</code> to
                match.
              </div>
            </div>
          </div>
        )}

        {/* Error banner (non-auth) */}
        {error && !unauthorized && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
          >
            <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1">
              <div className="font-semibold">Could not load all data</div>
              <div className="mt-0.5">{error}</div>
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {insights
              ? `Range: ${insights.range} · ${insights.summary.totalSearches} searches`
              : 'Loading…'}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadAll()}
            disabled={loading}
            className="h-7 gap-1 text-xs"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            Refresh
          </Button>
        </div>

        {/* Summary stats */}
        {insights && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryCard
              label="Total searches"
              value={insights.summary.totalSearches.toString()}
            />
            <SummaryCard
              label="Unique queries"
              value={insights.summary.totalUniqueQueries.toString()}
            />
            <SummaryCard
              label="Avg latency"
              value={`${Math.round(insights.summary.avgLatencyMs)}ms`}
            />
            <SummaryCard
              label="Zero-result rate"
              value={`${(insights.summary.zeroResultRate * 100).toFixed(1)}%`}
            />
          </div>
        )}

        {/* Tabbed sections */}
        <Tabs defaultValue="queries" className="mt-2">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="queries" className="text-xs">Queries</TabsTrigger>
            <TabsTrigger value="domains" className="text-xs">Domains</TabsTrigger>
            <TabsTrigger value="system" className="text-xs">System</TabsTrigger>
            <TabsTrigger value="recent" className="text-xs">Recent</TabsTrigger>
          </TabsList>

          {/* Top queries + trending */}
          <TabsContent value="queries" className="mt-3 space-y-4">
            <section aria-label="Top queries">
              <SectionHeader icon={BarChart3} title="Top 10 queries" />
              <DataTable
                headers={['Query', 'Frequency']}
                rows={(insights?.topQueries ?? []).slice(0, 10).map((q) => [
                  <span
                    key="q"
                    className="truncate font-mono text-foreground"
                    title={q.query}
                  >
                    {q.query}
                  </span>,
                  <span key="f" className="font-mono">
                    {q.frequency}
                  </span>,
                ])}
                empty={insights ? 'No queries in the last 24h.' : undefined}
              />
            </section>

            <section aria-label="Trending queries">
              <SectionHeader icon={TrendingUp} title="Trending (top 5)" />
              <DataTable
                headers={['Query', 'Frequency']}
                rows={(insights?.trending ?? []).slice(0, 5).map((q) => [
                  <span key="t" className="truncate font-mono text-foreground" title={q.query}>
                    {q.query}
                  </span>,
                  <span key="f" className="font-mono">
                    {q.frequency}
                  </span>,
                ])}
                empty={insights ? 'No trending queries.' : undefined}
              />
            </section>

            {(insights?.zeroResultQueries?.length ?? 0) > 0 && (
              <section aria-label="Zero-result queries">
                <SectionHeader icon={AlertTriangle} title="Zero-result queries" />
                <DataTable
                  headers={['Query', 'Frequency']}
                  rows={insights!.zeroResultQueries.slice(0, 10).map((q) => [
                    <span
                      key="z"
                      className="truncate font-mono text-rose-600 dark:text-rose-400"
                      title={q.query}
                    >
                      {q.query}
                    </span>,
                    <span key="f" className="font-mono">
                      {q.frequency}
                    </span>,
                  ])}
                />
              </section>
            )}
          </TabsContent>

          {/* Top domains + index growth */}
          <TabsContent value="domains" className="mt-3 space-y-4">
            <section aria-label="Top domains">
              <SectionHeader icon={Globe2} title="Top 10 domains" />
              <DataTable
                headers={['Domain', 'Docs', 'Avg quality']}
                rows={(insights?.topDomains ?? []).slice(0, 10).map((d) => [
                  <span key="d" className="truncate font-mono text-foreground" title={d.domain}>
                    {d.domain}
                  </span>,
                  <span key="c" className="font-mono">
                    {d.docCount}
                  </span>,
                  <span key="q" className="font-mono">
                    {d.avgQuality.toFixed(2)}
                  </span>,
                ])}
                empty={insights ? 'No domains indexed.' : undefined}
              />
            </section>

            <section aria-label="Index growth">
              <SectionHeader icon={Database} title="Index growth (per day)" />
              {(insights?.indexGrowth?.length ?? 0) > 0 ? (
                <ul className="space-y-1 text-xs">
                  {insights!.indexGrowth.map((g) => (
                    <li
                      key={g.date}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5"
                    >
                      <span className="font-mono text-muted-foreground">
                        {g.date}
                      </span>
                      <span className="font-mono font-medium text-foreground">
                        +{g.docCount} docs
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyRow text="No new documents crawled in this range." />
              )}
            </section>
          </TabsContent>

          {/* BrightData budget + Health + sparklines */}
          <TabsContent value="system" className="mt-3 space-y-4">
            {/* Sparklines — small inline line + bar charts that surface
                activity at a glance. Two sparklines: searches per hour
                (bar chart, last 24h) and index growth (line chart, last 7d).
                Plus a "p50 latency" badge next to the avg latency. */}
            <section aria-label="Activity sparklines">
              <div className="flex items-center justify-between">
                <SectionHeader icon={TrendingUp} title="Activity (sparklines)" />
                {insights && (
                  <Badge
                    variant="outline"
                    className="text-[10px] font-mono"
                    title="Median search latency"
                  >
                    p50 {Math.round(insights.summary.avgLatencyMs)}ms
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <SparklineCard label="Searches (24h)">
                  <SearchesSparkline recent={insights?.recent ?? []} />
                </SparklineCard>
                <SparklineCard label="Index growth (7d)">
                  <IndexGrowthSparkline data={insights?.indexGrowth ?? []} />
                </SparklineCard>
              </div>
            </section>

            <section aria-label="BrightData budget">
              <SectionHeader icon={Activity} title="BrightData budget" />
              {budget ? (
                <div className="space-y-3 rounded-md border border-border/60 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Status</span>
                    <Badge variant={budget.enabled ? 'default' : 'secondary'} className="text-[10px]">
                      {budget.enabled ? 'enabled' : 'free-tier'}
                    </Badge>
                  </div>
                  <BudgetBar
                    label="Daily"
                    used={budget.budget.daily.used}
                    cap={budget.budget.daily.cap}
                  />
                  <BudgetBar
                    label="Monthly"
                    used={budget.budget.monthly.used}
                    cap={budget.budget.monthly.cap}
                  />
                  <Separator />
                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div className="flex items-center justify-between">
                      <span>Successful</span>
                      <span className="font-mono text-foreground">
                        {budget.totals.successful}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Fallbacks</span>
                      <span className="font-mono text-foreground">
                        {budget.totals.fallbacks}
                      </span>
                    </div>
                  </div>
                  {budget.disabledKinds.length > 0 && (
                    <div className="text-xs text-amber-600 dark:text-amber-400">
                      Disabled: {budget.disabledKinds.join(', ')}
                    </div>
                  )}
                  {budget.lastError && (
                    <div className="break-words text-xs text-rose-600 dark:text-rose-400">
                      Last error: {budget.lastError}
                    </div>
                  )}
                </div>
              ) : (
                <EmptyRow text="BrightData budget not available." />
              )}
            </section>

            <section aria-label="Tool usage">
              <SectionHeader icon={BarChart3} title="Tool usage" />
              {insights && Object.keys(insights.toolUsage).length > 0 ? (
                <ul className="space-y-1 text-xs">
                  {Object.entries(insights.toolUsage).map(([k, v]) => (
                    <li
                      key={k}
                      className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-2 py-1.5"
                    >
                      <span className="font-mono text-muted-foreground capitalize">
                        {k}
                      </span>
                      <span className="font-mono font-medium text-foreground">
                        {v}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyRow text="No tool usage in this range." />
              )}
            </section>

            <section aria-label="Health check">
              <SectionHeader icon={ShieldAlert} title="Health check" />
              {health ? (
                <div className="space-y-2 rounded-md border border-border/60 p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Overall</span>
                    <HealthBadge status={health.status} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Uptime</span>
                    <span className="font-mono text-foreground">
                      {formatUptime(health.uptime)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Response</span>
                    <span className="font-mono text-foreground">
                      {health.responseMs}ms
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Version</span>
                    <span className="font-mono text-foreground">
                      {health.version}
                    </span>
                  </div>
                  <Separator />
                  <div className="space-y-1">
                    {Object.entries(health.checks ?? {}).map(([k, v]: [string, any]) => (
                      <li
                        key={k}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="text-muted-foreground capitalize">
                          {k}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          {v?.ok ? (
                            <CheckCircle2
                              className="size-3.5 text-emerald-600 dark:text-emerald-400"
                              aria-hidden
                            />
                          ) : (
                            <XCircle
                              className="size-3.5 text-rose-600 dark:text-rose-400"
                              aria-hidden
                            />
                          )}
                          <span className="font-mono text-foreground">
                            {v?.latencyMs != null
                              ? `${v.latencyMs}ms`
                              : v?.ok
                                ? 'ok'
                                : v?.error ?? 'fail'}
                          </span>
                        </span>
                      </li>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyRow text="Health check unavailable." />
              )}
            </section>
          </TabsContent>

          {/* Recent searches */}
          <TabsContent value="recent" className="mt-3 space-y-2">
            <SectionHeader icon={Activity} title="Recent searches (last 10)" />
            {(insights?.recent?.length ?? 0) > 0 ? (
              <ul className="space-y-1">
                {insights!.recent.slice(0, 10).map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs"
                  >
                    <span
                      className="truncate font-mono text-foreground"
                      title={r.query ?? ''}
                    >
                      {r.query ?? '—'}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                      {typeof r.tookMs === 'number' && (
                        <span className="font-mono">{r.tookMs}ms</span>
                      )}
                      {typeof r.totalFound === 'number' && (
                        <span className="font-mono">
                          {r.totalFound} found
                        </span>
                      )}
                      {r.timestamp && (
                        <span className="font-mono">
                          {new Date(r.timestamp).toLocaleTimeString()}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyRow text="No recent searches." />
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// --- Sub-components --------------------------------------------------------

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-base font-semibold text-foreground">
        {value}
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  title: string
}) {
  return (
    <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      <Icon className="size-3.5 text-primary" aria-hidden />
      {title}
    </h3>
  )
}

function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[]
  rows: React.ReactNode[][]
  empty?: string
}) {
  if (rows.length === 0) {
    return <EmptyRow text={empty ?? 'No data.'} />
  }
  return (
    <div className="rounded-md border border-border/60">
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((h) => (
              <TableHead key={h} className="h-8 text-[10px] uppercase tracking-wider">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell
                  key={j}
                  className={cn('py-1.5 text-xs', j === 0 && 'max-w-[60%]')}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
      {text}
    </div>
  )
}

function BudgetBar({
  label,
  used,
  cap,
}: {
  label: string
  used: number
  cap: number
}) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground">
          {used} / {cap}
        </span>
      </div>
      <Progress
        value={pct}
        className="mt-1 h-1.5"
        aria-label={`${label} budget: ${used} of ${cap}`}
      />
    </div>
  )
}

function HealthBadge({ status }: { status: HealthCheck['status'] }) {
  const cfg = {
    ok: {
      label: 'ok',
      color: 'text-emerald-600 dark:text-emerald-400',
      icon: CheckCircle2,
    },
    degraded: {
      label: 'degraded',
      color: 'text-amber-600 dark:text-amber-400',
      icon: AlertTriangle,
    },
    down: {
      label: 'down',
      color: 'text-rose-600 dark:text-rose-400',
      icon: XCircle,
    },
    unknown: {
      label: 'unknown',
      color: 'text-muted-foreground',
      icon: AlertTriangle,
    },
  } as const
  const c = cfg[status] ?? cfg.unknown
  const Icon = c.icon
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono', c.color)}>
      <Icon className="size-3.5" aria-hidden />
      {c.label}
    </span>
  )
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

// --- Sparkline components ---------------------------------------------------

/**
 * SparklineCard — a small bordered container with a label (top-left) + a
 * 40px-tall chart slot. Keeps the sparkline visually consistent across
 * the System tab.
 */
function SparklineCard({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="h-10 w-full">{children}</div>
    </div>
  )
}

/**
 * SearchesSparkline — bar chart of searches per hour (last 24h). Buckets
 * the `recent` array by hour-of-day and counts entries per bucket. Empty
 * hours render as zero-height bars so the chart always spans 24 buckets.
 *
 * Bar fill is gold/40 (matches the CIRKLE brand). X axis is hidden — we
 * only need the shape of the distribution at a glance.
 */
function SearchesSparkline({ recent }: { recent: RecentSearch[] }) {
  const data = React.useMemo(() => {
    // Build 24 buckets for the last 24 hours (newest on the right).
    const now = Date.now()
    const buckets: { hour: string; count: number }[] = []
    for (let i = 23; i >= 0; i--) {
      const t = new Date(now - i * 60 * 60 * 1000)
      buckets.push({
        hour: t.getHours().toString().padStart(2, '0'),
        count: 0,
      })
    }
    for (const r of recent) {
      if (!r.timestamp) continue
      const ts = Date.parse(r.timestamp)
      if (!Number.isFinite(ts)) continue
      const hoursAgo = Math.floor((now - ts) / (60 * 60 * 1000))
      if (hoursAgo < 0 || hoursAgo >= 24) continue
      buckets[23 - hoursAgo].count++
    }
    return buckets
  }, [recent])

  if (recent.length === 0) {
    return <EmptyRow text="No searches in the last 24h." />
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <XAxis dataKey="hour" hide />
        <Bar
          dataKey="count"
          fill="hsl(var(--gold) / 0.4)"
          stroke="hsl(var(--gold))"
          strokeWidth={1}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted-foreground) / 0.1)' }}
          contentStyle={{
            background: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '11px',
            padding: '4px 8px',
          }}
          labelFormatter={(l) => `Hour ${l}`}
          formatter={(v: any) => [v, 'searches']}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * IndexGrowthSparkline — line chart of doc count by day (last 7d). Uses
 * the `indexGrowth` array straight from /api/insights. Line stroke is
 * primary (teal), no fill — clean silhouette of the index growth curve.
 */
function IndexGrowthSparkline({
  data,
}: {
  data: IndexGrowthPoint[]
}) {
  const chartData = React.useMemo(
    () =>
      data.map((d) => ({
        date: d.date.slice(5), // MM-DD only — keeps the X axis compact
        docs: d.docCount,
      })),
    [data],
  )

  if (chartData.length === 0) {
    return <EmptyRow text="No index growth in the last 7d." />
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: 0 }}>
        <XAxis dataKey="date" hide />
        <Line
          type="monotone"
          dataKey="docs"
          stroke="hsl(var(--primary))"
          strokeWidth={1.5}
          dot={false}
          fill="none"
          isAnimationInitial={false}
          isAnimationActive={false}
        />
        <Tooltip
          cursor={{ stroke: 'hsl(var(--muted-foreground) / 0.3)' }}
          contentStyle={{
            background: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '11px',
            padding: '4px 8px',
          }}
          formatter={(v: any) => [v, 'docs']}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

export default InsightsDashboard
