// @ts-nocheck — Inngest SDK streaming type (runtime works fine)
/**
 * GET/POST/PUT /api/inngest — Inngest function registration + job dispatch.
 *
 * Inngest calls this endpoint to:
 *   - GET  → register the functions (cron schedules, names)
 *   - POST → execute a triggered function (cron, event, or step)
 *   - PUT  → handle step completion
 *
 * The functions are defined in src/lib/inngest.ts.
 * When deployed to Vercel, Inngest will discover this endpoint and schedule
 * the cron jobs automatically.
 */
import { serve } from 'inngest/next'
import { inngest, inngestFunctions } from '@/lib/inngest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: inngestFunctions,
  streaming: 'allow',
})
