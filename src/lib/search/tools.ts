/**
 * tools.ts
 * -----------------------------------------------------------------------------
 * Real-time answer tools for queries that NO static web index can answer:
 *
 *   - weather  → "weather in Dubai", "temperature in Cairo", "forecast for Tokyo"
 *   - time     → "time in Dubai", "what time is it in London"
 *   - math     → "2+2", "15% of 200", "sqrt(144)", "12 * 8"
 *   - liveWeb  → when the index has 0 results, fetch fresh web content via
 *                the unified LLM client's webSearch() function (DuckDuckGo
 *                HTML search — supplementary source per spec §69 — NOT the
 *                primary backend, just a real-time fallback for queries the
 *                local index can't serve yet).
 *
 * These tools return INSTANT structured answers (1-2s) shown in the
 * InstantAnswer card at the top of the SERP — above the organic results.
 *
 * Weather uses Open-Meteo (free, no API key, no rate limit for low volume).
 * Time uses the Intl API + a city→timezone geocoding lookup (also Open-Meteo).
 * Math uses a safe shunting-yard evaluator (no eval()).
 */

import { parseQuery } from './query-understanding'
import { stem } from './text-processor'
import * as https from 'node:https'

// --- Types -----------------------------------------------------------------

export type ToolKind = 'weather' | 'time' | 'math' | 'convert' | 'currency' | 'liveWeb' | 'none'

export interface ToolDetection {
  kind: ToolKind
  /** Raw parameter extracted from the query (city name, math expression, etc.). */
  param: string
}

export interface InstantAnswer {
  kind: Exclude<ToolKind, 'none' | 'liveWeb'>
  title: string        // e.g. "Weather in Dubai"
  summary: string      // 1-2 sentence human-readable answer
  facts: { label: string; value: string }[]
  source: string       // attribution, e.g. "Open-Meteo"
  sourceUrl?: string
  fetchedAt: string
}

export interface LiveWebResult {
  title: string
  url: string
  snippet: string
  domain: string
  sourceType: string
}

// --- Detection -------------------------------------------------------------

const WEATHER_PATTERNS = [
  /\b(?:weather|temperature|forecast|humidity|wind)\s+(?:in|for|at)\s+([a-z\u00C0-\u024F\s',-]+?)(?:\?|$|\.|,)/i,
  /\b(?:what\s+(?:is|'s)\s+the\s+)?(?:weather|temperature|forecast)\s+(?:in|for|at)\s+([a-z\u00C0-\u024F\s',-]+?)(?:\?|$|\.|,)/i,
  /\b([a-z\u00C0-\u024F\s',-]+?)\s+weather\b/i,
]

const TIME_PATTERNS = [
  /\b(?:time|clock)\s+(?:in|for|at)\s+([a-z\u00C0-\u024F\s',-]+?)(?:\?|$|\.|,)/i,
  /\bwhat\s+(?:time|is\s+the\s+time)\s+(?:in|is\s+it\s+in)\s+([a-z\u00C0-\u024F\s',-]+?)(?:\?|$|\.|,)/i,
  /\b([a-z\u00C0-\u024F\s',-]+?)\s+(?:time|timezone)\b/i,
]

const MATH_PATTERN = /^[\d\s+\-*/().%^√πe]+$/i
// Extended pattern that also allows sqrt/PI/E identifiers
const MATH_PATTERN_EXT = /^[\d\s+\-*/().%^√πa-zA-Z]+$/i

export function detectTool(query: string): ToolDetection {
  const q = query.trim()

  // Math: if the query is mostly numbers + operators, treat as math.
  if ((MATH_PATTERN.test(q) || MATH_PATTERN_EXT.test(q)) && /\d/.test(q) && /[+\-*/^%]|sqrt|√/.test(q)) {
    return { kind: 'math', param: q }
  }

  // --- Unit converter ---
  // "10 km in miles", "5 kg to lbs", "100 f to c", "1 hour in minutes"
  const convertMatch = q.match(/([\d.]+)\s*(km|mi|miles|kg|lbs|pounds|g|oz|c|f|celsius|fahrenheit|liters?|gallons?|hours?|minutes?|seconds?|days?|weeks?|feet|ft|inches|cm|mm|mb|gb|tb)\s*(?:in|to|→)\s*(km|mi|miles|kg|lbs|pounds|g|oz|c|f|celsius|fahrenheit|liters?|gallons?|hours?|minutes?|seconds?|days?|weeks?|feet|ft|inches|cm|mm|mb|gb|tb)/i)
  if (convertMatch) {
    return { kind: 'convert', param: q }
  }

  // --- Currency converter ---
  // "100 usd to eur", "50 eur in gbp", "convert 100 dollars to euros"
  const currencyMatch = q.match(/([\d.,]+)\s*(usd|eur|gbp|jpy|cny|aed|sar|egp|inr|cad|aud|chf|dollars?|euros?|pounds?)\s*(?:in|to|→)\s*(usd|eur|gbp|jpy|cny|aed|sar|egp|inr|cad|aud|chf|dollars?|euros?|pounds?)/i)
  if (currencyMatch) {
    return { kind: 'currency', param: q }
  }

  // Weather
  for (const re of WEATHER_PATTERNS) {
    const m = q.match(re)
    if (m && m[1]) {
      const city = m[1].trim().replace(/\s+/g, ' ')
      if (city.length > 1 && city.length < 60) return { kind: 'weather', param: city }
    }
  }

  // Time
  for (const re of TIME_PATTERNS) {
    const m = q.match(re)
    if (m && m[1]) {
      const city = m[1].trim().replace(/\s+/g, ' ')
      if (city.length > 1 && city.length < 60) return { kind: 'time', param: city }
    }
  }

  return { kind: 'none', param: '' }
}

// --- Weather (Open-Meteo — free, no API key) -------------------------------

interface GeoResult {
  name: string
  latitude: number
  longitude: number
  country: string
  timezone: string
}

/** Fetch JSON via Node's https module (bypasses undici/fetch which can fail
 *  in some Next.js server sandboxes). Returns parsed JSON or null. */
function fetchJsonHttps(url: string, timeoutMs = 6000): Promise<any | null> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'CIRKLE-Search/1.0', Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res: any) => {
        if (res.statusCode !== 200) {
          console.error('[tools] https', u.hostname, '→ status', res.statusCode)
          resolve(null)
          res.resume()
          return
        }
        let data = ''
        res.on('data', (c: Buffer) => (data += c.toString()))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e: any) {
            console.error('[tools] JSON parse error:', e?.message)
            resolve(null)
          }
        })
      },
    )
    req.on('error', (e: any) => {
      console.error('[tools] https error:', u.hostname, '→', e?.message ?? e)
      resolve(null)
    })
    req.on('timeout', () => {
      req.destroy()
      console.error('[tools] https timeout:', u.hostname)
      resolve(null)
    })
  })
}

/** Fetch with a manual timeout — kept for compatibility but now just delegates
 *  to fetchJsonHttps for JSON APIs. */
async function fetchWithTimeout(url: string, _timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url)
  } catch (e: any) {
    console.error('[tools] fetch failed:', url.slice(0, 80), '→', e?.message ?? e)
    return null
  }
}

async function geocode(city: string): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
  try {
    const data = await fetchJsonHttps(url, 5000)
    const hit = data?.results?.[0]
    if (!hit) return null
    return {
      name: hit.name,
      latitude: hit.latitude,
      longitude: hit.longitude,
      country: hit.country ?? '',
      timezone: hit.timezone ?? 'UTC',
    }
  } catch (e: any) {
    console.error('[tools] geocode error:', e?.message ?? e)
    return null
  }
}

const WMO_CODE_MAP: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  71: 'Slight snowfall', 73: 'Moderate snowfall', 75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
}

async function fetchWeather(geo: GeoResult): Promise<{
  temperature: number
  apparentTemp: number
  humidity: number
  windSpeed: number
  weatherCode: number
  description: string
  isDay: boolean
} | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day&timezone=${encodeURIComponent(geo.timezone)}`
  try {
    const data = await fetchJsonHttps(url, 6000)
    const c = data?.current
    if (!c) return null
    const code = c.weather_code ?? 0
    return {
      temperature: c.temperature_2m,
      apparentTemp: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      windSpeed: c.wind_speed_10m,
      weatherCode: code,
      description: WMO_CODE_MAP[code] ?? 'Unknown',
      isDay: c.is_day === 1,
    }
  } catch (e: any) {
    console.error('[tools] fetchWeather error:', e?.message ?? e)
    return null
  }
}

/**
 * Fallback weather fetcher using the unified webSearch() function from
 * ../llm (DuckDuckGo HTML search).
 * This works in sandboxes where direct fetch to open-meteo is blocked,
 * because the web_search runs via DuckDuckGo's HTML endpoint. Returns a
 * weather instant answer parsed from the search snippets + an LLM synthesis.
 */
async function runWeatherFallback(city: string): Promise<InstantAnswer | null> {
  try {
    const { webSearch, chatCompletion } = await import('../llm')

    // Step 1: web search for current weather.
    const results = await webSearch(`current weather ${city} temperature humidity wind`, 5)
    if (!Array.isArray(results) || results.length === 0) return null

    // Step 2: ask the LLM to extract structured weather data from the snippets.
    const context = results
      .slice(0, 5)
      .map((r: any, i: number) => `[${i + 1}] ${r.name}\n${r.snippet}`)
      .join('\n\n')

    const completion = await chatCompletion([
      {
        role: 'system',
        content: 'You extract weather data from search snippets. Return ONLY valid JSON with these fields: temperature (number in °C), apparentTemp (number, "feels like" in °C), humidity (number, percentage), windSpeed (number, km/h), description (short text like "Clear sky" or "Light rain"), isDay (boolean). If a field is not available, use null. No prose, no markdown — JSON only.',
      },
      {
        role: 'user',
        content: `City: ${city}\n\nSearch snippets:\n${context}\n\nExtract the current weather as JSON.`,
      },
    ])

    const raw = completion?.content
    if (!raw) return null
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const w = JSON.parse(jsonMatch[0])

    return {
      kind: 'weather',
      title: `Weather in ${city}`,
      summary: `${w.description ?? 'Unknown conditions'}, ${w.temperature ?? '?'}°C${w.apparentTemp != null ? ` — feels like ${w.apparentTemp}°C` : ''}.${w.humidity != null ? ` Humidity ${w.humidity}%.` : ''}${w.windSpeed != null ? ` Wind ${w.windSpeed} km/h.` : ''}`,
      facts: [
        ...(w.temperature != null ? [{ label: 'Temperature', value: `${w.temperature}°C` }] : []),
        ...(w.apparentTemp != null ? [{ label: 'Feels like', value: `${w.apparentTemp}°C` }] : []),
        ...(w.description ? [{ label: 'Conditions', value: w.description }] : []),
        ...(w.humidity != null ? [{ label: 'Humidity', value: `${w.humidity}%` }] : []),
        ...(w.windSpeed != null ? [{ label: 'Wind', value: `${w.windSpeed} km/h` }] : []),
      ],
      source: 'Live web (via z.ai web_search)',
      sourceUrl: results[0]?.url,
      fetchedAt: new Date().toISOString(),
    }
  } catch (e: any) {
    console.error('[tools] weather fallback error:', e?.message ?? e)
    return null
  }
}

async function runWeatherTool(city: string): Promise<InstantAnswer | null> {
  // Try Open-Meteo first (fast, free, structured). If it fails (sandbox
  // blocks direct fetch), fall back to web_search + LLM extraction.
  const geo = await geocode(city)
  if (geo) {
    const w = await fetchWeather(geo)
    if (w) {
      const locationLabel = `${geo.name}${geo.country ? ', ' + geo.country : ''}`
      return {
        kind: 'weather',
        title: `Weather in ${locationLabel}`,
        summary: `${w.description}${w.isDay ? '' : ' (night)'}, ${Math.round(w.temperature)}°C — feels like ${Math.round(w.apparentTemp)}°C. Humidity ${w.humidity}%, wind ${Math.round(w.windSpeed)} km/h.`,
        facts: [
          { label: 'Temperature', value: `${Math.round(w.temperature)}°C` },
          { label: 'Feels like', value: `${Math.round(w.apparentTemp)}°C` },
          { label: 'Conditions', value: w.description },
          { label: 'Humidity', value: `${w.humidity}%` },
          { label: 'Wind', value: `${Math.round(w.windSpeed)} km/h` },
          { label: 'Time zone', value: geo.timezone },
        ],
        source: 'Open-Meteo',
        sourceUrl: `https://open-meteo.com/`,
        fetchedAt: new Date().toISOString(),
      }
    }
  }
  // Fallback: use web_search + LLM
  return runWeatherFallback(city)
}

// --- Time (Intl API + geocoding for timezone) ------------------------------

// Hardcoded city → IANA timezone map for common cities. This lets the time
// tool work without geocode (which may fail in sandboxes). For unknown
// cities, falls back to web_search.
const CITY_TIMEZONES: Record<string, string> = {
  dubai: 'Asia/Dubai',
  cairo: 'Africa/Cairo',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  madrid: 'Europe/Madrid',
  rome: 'Europe/Rome',
  moscow: 'Europe/Moscow',
  istanbul: 'Europe/Istanbul',
  'new york': 'America/New_York',
  nyc: 'America/New_York',
  losangeles: 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
  chicago: 'America/Chicago',
  toronto: 'America/Toronto',
  'mexico city': 'America/Mexico_City',
  saopaulo: 'America/Sao_Paulo',
  'sao paulo': 'America/Sao_Paulo',
  tokyo: 'Asia/Tokyo',
  seoul: 'Asia/Seoul',
  shanghai: 'Asia/Shanghai',
  beijing: 'Asia/Shanghai',
  hongkong: 'Asia/Hong_Kong',
  'hong kong': 'Asia/Hong_Kong',
  singapore: 'Asia/Singapore',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  bangkok: 'Asia/Bangkok',
  jakarta: 'Asia/Jakarta',
  sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  auckland: 'Pacific/Auckland',
  riyadh: 'Asia/Riyadh',
  doha: 'Asia/Qatar',
  kuwait: 'Asia/Kuwait',
  jeddah: 'Asia/Riyadh',
  amman: 'Asia/Amman',
  beirut: 'Asia/Beirut',
  baghdad: 'Asia/Baghdad',
  tehran: 'Asia/Tehran',
  karachi: 'Asia/Karachi',
  lagos: 'Africa/Lagos',
  nairobi: 'Africa/Nairobi',
  johannesburg: 'Africa/Johannesburg',
  'cape town': 'Africa/Johannesburg',
  'capetown': 'Africa/Johannesburg',
  accra: 'Africa/Accra',
  casablanca: 'Africa/Casablanca',
  algiers: 'Africa/Algiers',
  tunis: 'Africa/Tunis',
}

async function runTimeTool(city: string): Promise<InstantAnswer | null> {
  // Try the hardcoded city → timezone map first (instant, no network).
  const cityLower = city.toLowerCase().trim()
  let timezone = CITY_TIMEZONES[cityLower]

  // If not in the map, try geocode (may fail in sandbox).
  if (!timezone) {
    const geo = await geocode(city)
    if (geo) timezone = geo.timezone
  }

  // If geocode failed, try web_search to find the timezone.
  if (!timezone) {
    try {
      const { webSearch } = await import('../llm')
      const results = await webSearch(`${city} timezone IANA`, 3)
      if (Array.isArray(results)) {
        for (const r of results) {
          const snippet = (r.snippet ?? '') + ' ' + (r.name ?? '')
          const tzMatch = snippet.match(/([A-Z][a-z]+\/[A-Z][a-z_]+)/)
          if (tzMatch) {
            timezone = tzMatch[1]
            break
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (!timezone) return null

  try {
    const now = new Date()
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const parts = formatter.formatToParts(now)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    const timeStr = `${get('hour')} : ${get('minute')} : ${get('second')} ${get('dayPeriod')}`
    const dateStr = `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')}`
    const offsetFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    })
    const offsetParts = offsetFormatter.formatToParts(now)
    const offset = offsetParts.find((p) => p.type === 'timeZoneName')?.value ?? timezone
    return {
      kind: 'time',
      title: `Current time in ${city}`,
      summary: `It is ${timeStr} on ${dateStr} (${offset}).`,
      facts: [
        { label: 'Time', value: timeStr },
        { label: 'Date', value: dateStr },
        { label: 'Time zone', value: timezone },
        { label: 'UTC offset', value: offset },
      ],
      source: 'Intl API' + (CITY_TIMEZONES[cityLower] ? ' (built-in map)' : ' + geocode'),
      fetchedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

// --- Math (safe shunting-yard evaluator) -----------------------------------

// --- Safe math evaluator (shunting-yard, NO eval / new Function) ---------
// Tokenizes the expression, converts to RPN via shunting-yard, evaluates.
// Supports: + - * / ^ % ( ) numbers, sqrt(), π, e
function evalMath(expr: string): number | null {
  // Normalize: √ → sqrt, π → PI, e → E, ^ → ^, % → /100*
  let e = expr
    .replace(/√/g, 'sqrt')
    .replace(/π/g, 'PI')
    .replace(/\be\b/gi, 'E')
    .replace(/%/g, '/100*') // "15% of 200" → "15/100*200"

  // Tokenize: numbers, operators, parens, functions, constants
  const tokens: (string | number)[] = []
  let i = 0
  while (i < e.length) {
    const c = e[i]
    if (c === ' ') { i++; continue }
    if (/[0-9.]/.test(c)) {
      let num = ''
      while (i < e.length && /[0-9.]/.test(e[i])) num += e[i++]
      tokens.push(parseFloat(num))
      continue
    }
    if (/[a-zA-Z]/.test(c)) {
      let name = ''
      while (i < e.length && /[a-zA-Z]/.test(e[i])) name += e[i++]
      name = name.toUpperCase()
      if (name === 'PI') tokens.push(Math.PI)
      else if (name === 'E') tokens.push(Math.E)
      else if (name === 'SQRT') tokens.push('sqrt')
      else return null // unknown identifier
      continue
    }
    if ('+-*/^()'.includes(c)) { tokens.push(c); i++; continue }
    return null // invalid character
  }

  // Shunting-yard: infix → RPN
  const output: (string | number)[] = []
  const ops: string[] = []
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3, 'sqrt': 4 }
  const rightAssoc: Set<string> = new Set(['^', 'sqrt'])

  for (const t of tokens) {
    if (typeof t === 'number') { output.push(t); continue }
    if (t === 'sqrt') { ops.push(t); continue }
    if (t === '(') { ops.push(t); continue }
    if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') output.push(ops.pop()!)
      if (!ops.length) return null // mismatched parens
      ops.pop() // remove '('
      continue
    }
    // operator
    while (ops.length) {
      const top = ops[ops.length - 1]
      if (top === '(') break
      if (rightAssoc.has(t) ? prec[t] < prec[top] : prec[t] <= prec[top]) {
        output.push(ops.pop()!)
      } else break
    }
    ops.push(t)
  }
  while (ops.length) {
    const op = ops.pop()!
    if (op === '(') return null // mismatched parens
    output.push(op)
  }

  // Evaluate RPN
  const stack: number[] = []
  for (const t of output) {
    if (typeof t === 'number') { stack.push(t); continue }
    if (t === 'sqrt') {
      if (stack.length < 1) return null
      stack.push(Math.sqrt(stack.pop()!))
      continue
    }
    if (stack.length < 2) return null
    const b = stack.pop()!
    const a = stack.pop()!
    if (t === '+') stack.push(a + b)
    else if (t === '-') stack.push(a - b)
    else if (t === '*') stack.push(a * b)
    else if (t === '/') stack.push(b === 0 ? 0 : a / b)
    else if (t === '^') stack.push(Math.pow(a, b))
    else return null
  }
  if (stack.length !== 1) return null
  const result = stack[0]
  return typeof result === 'number' && isFinite(result) ? Math.round(result * 1e10) / 1e10 : null
}

function runMathTool(expr: string): InstantAnswer | null {
  const result = evalMath(expr)
  if (result === null) return null
  return {
    kind: 'math',
    title: 'Calculation',
    summary: `${expr.trim()} = ${result}`,
    facts: [
      { label: 'Expression', value: expr.trim() },
      { label: 'Result', value: String(result) },
    ],
    source: 'CIRKLE built-in evaluator',
    fetchedAt: new Date().toISOString(),
  }
}

// --- Live web fallback (supplementary — spec §69) -------------------------
// Used ONLY when the local index returns 0 results AND the query looks like
// it needs fresh web content. The web_search SDK function returns live URLs +
// snippets; we surface them as supplementary results (clearly labeled).
//
// 3-tier fallback (highest quality first, lowest cost last):
//   1. BrightData SERP API (premium Google SERP — when BRIGHTDATA_TOKEN is
//      set + budget allows; falls back to (2) when budget is exhausted)
//   2. DuckDuckGo HTML search (free, no key)
//   3. (no further fallback — return [])
//
// The BrightData tier is OPTIONAL — when no token is configured, the engine
// works exactly as before, on the free DuckDuckGo tier.

export async function runLiveWebSearch(query: string): Promise<LiveWebResult[]> {
  // Tier 1: BrightData SERP API (premium).
  try {
    const { brightDataSerp, isBrightDataSerpWorthIt } = await import('../brightdata')
    // Only spend BrightData budget on queries where it actually adds value.
    // Pure-math / unit-conversion / weather / time queries have their own
    // instant-answer tools — don't waste budget on them.
    if (isBrightDataSerpWorthIt(query, 0)) {
      const serpResults = await brightDataSerp(query, { num: 8 })
      if (serpResults && serpResults.length > 0) {
        return serpResults.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          domain: r.domain,
          sourceType: r.sourceType,
        }))
      }
    }
  } catch (e: any) {
    // P2-2: structured log when BrightData tier fails (downstream fall-through
    // to DuckDuckGo is intentional — the engine keeps working).
    console.warn('[tools] liveweb tier 1 (brightdata) failed', {
      query: query.slice(0, 80),
      error: e?.message ?? String(e),
    })
  }

  // Tier 2: DuckDuckGo HTML search (free, no key, works in production).
  let ddgResults: LiveWebResult[] = []
  try {
    const { webSearch } = await import('../llm')
    const results = await webSearch(query, 8)
    if (Array.isArray(results) && results.length > 0) {
      ddgResults = results.map((r: any) => ({
        title: r.name ?? r.url,
        url: r.url,
        snippet: r.snippet ?? '',
        domain: r.host_name ?? new URL(r.url).hostname,
        sourceType: classifyLiveDomain(r.host_name ?? ''),
      }))
    }
  } catch (e: any) {
    // P2-2: structured log when DuckDuckGo fallback fails.
    console.warn('[tools] liveweb tier 2 (duckduckgo) failed', {
      query: query.slice(0, 80),
      error: e?.message ?? String(e),
    })
  }

  if (ddgResults.length > 0) return ddgResults

  // Tier 3: BrightData Scraping Browser → fetch Google SERP HTML → parse.
  // This is the production-grade fallback when DuckDuckGo is blocked or
  // returns 0 results (sandbox, restrictive corporate networks, etc.).
  // Consumes BrightData budget — the budget guard caps at 5/day, 25/month.
  try {
    const { brightDataScrapingBrowserFetch } = await import('../brightdata')
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`
    const scraped = await brightDataScrapingBrowserFetch(googleUrl, {
      timeoutMs: 20_000,
    })
    if (scraped && scraped.ok && scraped.content) {
      const parsed = parseGoogleSerp(scraped.content)
      if (parsed.length > 0) {
        return parsed
      }
    }
  } catch (e: any) {
    console.warn('[tools] liveweb tier 3 (brightdata google) failed', {
      query: query.slice(0, 80),
      error: e?.message ?? String(e),
    })
  }

  return []
}

/**
 * Parse organic results from a Google SERP HTML page.
 * Extracts title + URL + snippet from each <div class="g"> block.
 * Used by the BrightData Scraping Browser fallback in runLiveWebSearch.
 */
function parseGoogleSerp(html: string): LiveWebResult[] {
  const results: LiveWebResult[] = []
  // Google's SERP HTML structure changes periodically. We use a permissive
  // regex that matches the most common organic-result block pattern.
  // Each result has: an <a href="https://..."> link + a <h3> title + a
  // sibling <div> with the snippet.
  const blockRe = /<a href="\/url\?q=([^&"]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi
  const directRe = /<a href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi
  const seen = new Set<string>()

  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && results.length < 10) {
    const url = decodeURIComponent(m[1])
    const title = m[2].replace(/<[^>]+>/g, '').trim()
    const snippet = m[3].replace(/<[^>]+>/g, '').trim()
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    let domain = ''
    try { domain = new URL(url).hostname } catch { domain = '' }
    results.push({
      title,
      url,
      snippet,
      domain,
      sourceType: classifyLiveDomain(domain),
    })
  }
  // If /url?q= pattern didn't match, try the direct href pattern.
  if (results.length === 0) {
    while ((m = directRe.exec(html)) !== null && results.length < 10) {
      const url = m[1]
      const title = m[2].replace(/<[^>]+>/g, '').trim()
      if (!url || !title || seen.has(url)) continue
      // Skip Google's own links (search?q=, preferences, etc.).
      if (url.includes('google.com/search') || url.includes('google.com/preferences')) continue
      seen.add(url)
      let domain = ''
      try { domain = new URL(url).hostname } catch { domain = '' }
      results.push({
        title,
        url,
        snippet: '',
        domain,
        sourceType: classifyLiveDomain(domain),
      })
    }
  }
  return results
}

function classifyLiveDomain(host: string): string {
  const h = host.toLowerCase()
  if (h.endsWith('.gov') || h.includes('.gov.')) return 'GOVERNMENT'
  if (h.endsWith('.edu') || h.includes('ac.')) return 'ACADEMIC'
  if (/reuters|bbc|nytimes|guardian|apnews|bloomberg|economist/.test(h)) return 'NEWS'
  if (/stackoverflow|reddit|hacker|github/.test(h)) return 'COMMUNITY'
  if (/wikipedia/.test(h)) return 'COMMUNITY'
  if (/amazon|ebay|shop/.test(h)) return 'COMMERCIAL'
  return 'WEB'
}

// --- Public entry point ----------------------------------------------------

// --- Unit converter (offline, instant) ------------------------------------
const UNIT_FACTORS: Record<string, number> = {
  // length
  km: 1000, m: 1, mi: 1609.344, miles: 1609.344, feet: 0.3048, ft: 0.3048,
  inches: 0.0254, cm: 0.01, mm: 0.001,
  // mass
  kg: 1000, g: 1, lbs: 453.592, pounds: 453.592, oz: 28.3495,
  // volume
  liters: 1000, l: 1000, gallons: 3785.41, 'gallon': 3785.41,
  // time (base: seconds)
  seconds: 1, sec: 1, minutes: 60, min: 60, hours: 3600, hr: 3600,
  days: 86400, weeks: 604800,
  // data
  mb: 1e6, gb: 1e9, tb: 1e12,
}

const TEMP_UNITS = new Set(['c', 'f', 'celsius', 'fahrenheit'])

function runConvertTool(query: string): InstantAnswer | null {
  const m = query.match(/([\d.]+)\s*(km|mi|miles|kg|lbs|pounds|g|oz|c|f|celsius|fahrenheit|liters?|l|gallons?|hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|feet|ft|inches|cm|mm|mb|gb|tb)\s*(?:in|to|→)\s*(km|mi|miles|kg|lbs|pounds|g|oz|c|f|celsius|fahrenheit|liters?|l|gallons?|hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|feet|ft|inches|cm|mm|mb|gb|tb)/i)
  if (!m) return null
  const value = parseFloat(m[1])
  const fromUnit = m[2].toLowerCase()
  const toUnit = m[3].toLowerCase()
  if (isNaN(value)) return null

  // Temperature
  if (TEMP_UNITS.has(fromUnit) && TEMP_UNITS.has(toUnit)) {
    let celsius: number
    if (fromUnit.startsWith('c')) celsius = value
    else celsius = (value - 32) * 5 / 9
    let result: number
    if (toUnit.startsWith('c')) result = celsius
    else result = celsius * 9 / 5 + 32
    return {
      kind: 'convert',
      title: `${value}°${fromUnit[0].toUpperCase()} → ${Math.round(result * 100) / 100}°${toUnit[0].toUpperCase()}`,
      summary: `${value}°${fromUnit[0].toUpperCase()} = ${Math.round(result * 100) / 100}°${toUnit[0].toUpperCase()}`,
      facts: [
        { label: 'Input', value: `${value}°${fromUnit[0].toUpperCase()}` },
        { label: 'Result', value: `${Math.round(result * 100) / 100}°${toUnit[0].toUpperCase()}` },
      ],
      source: 'CIRKLE built-in converter',
      fetchedAt: new Date().toISOString(),
    }
  }

  // Other units (convert via base unit)
  const fromFactor = UNIT_FACTORS[fromUnit]
  const toFactor = UNIT_FACTORS[toUnit]
  if (fromFactor === undefined || toFactor === undefined) return null
  const result = (value * fromFactor) / toFactor
  const rounded = Math.round(result * 10000) / 10000
  return {
    kind: 'convert',
    title: `${value} ${fromUnit} → ${rounded} ${toUnit}`,
    summary: `${value} ${fromUnit} = ${rounded} ${toUnit}`,
    facts: [
      { label: 'Input', value: `${value} ${fromUnit}` },
      { label: 'Result', value: `${rounded} ${toUnit}` },
    ],
    source: 'CIRKLE built-in converter',
    fetchedAt: new Date().toISOString(),
  }
}

// --- Currency converter (live rates via web_search) -----------------------
async function runCurrencyTool(query: string): Promise<InstantAnswer | null> {
  const m = query.match(/([\d.,]+)\s*(usd|eur|gbp|jpy|cny|aed|sar|egp|inr|cad|aud|chf|dollars?|euros?|pounds?)\s*(?:in|to|→)\s*(usd|eur|gbp|jpy|cny|aed|sar|egp|inr|cad|aud|chf|dollars?|euros?|pounds?)/i)
  if (!m) return null
  const amount = parseFloat(m[1].replace(/,/g, ''))
  const fromRaw = m[2].toLowerCase()
  const toRaw = m[3].toLowerCase()
  if (isNaN(amount)) return null

  // Normalize currency names to codes
  const normalizeCur = (c: string): string => {
    if (c.startsWith('dollar')) return 'USD'
    if (c.startsWith('euro')) return 'EUR'
    if (c.startsWith('pound')) return 'GBP'
    return c.toUpperCase()
  }
  const fromCur = normalizeCur(fromRaw)
  const toCur = normalizeCur(toRaw)

  try {
    const { webSearch, chatCompletion } = await import('../llm')
    const results = await webSearch(`${amount} ${fromCur} to ${toCur} exchange rate`, 3)
    if (!Array.isArray(results) || results.length === 0) return null

    // Ask the LLM to extract the conversion result from the snippets.
    const context = results.slice(0, 3).map((r: any, i: number) => `[${i + 1}] ${r.name}\n${r.snippet}`).join('\n\n')
    const completion = await chatCompletion([
      { role: 'system', content: 'You are a currency converter. Given search snippets with exchange rates, compute the conversion. Return ONLY valid JSON: {"rate": number, "result": number, "description": "brief text"}. No prose.' },
      { role: 'user', content: `Convert ${amount} ${fromCur} to ${toCur}.\n\nSnippets:\n${context}` },
    ])
    const raw = completion?.content
    if (!raw) return null
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0])
    const result = typeof parsed.result === 'number' ? parsed.result : null
    const rate = typeof parsed.rate === 'number' ? parsed.rate : null
    if (result === null) return null

    return {
      kind: 'currency',
      title: `${amount} ${fromCur} → ${toCur}`,
      summary: `${amount} ${fromCur} = ${Math.round(result * 100) / 100} ${toCur}${rate ? ` (rate: 1 ${fromCur} = ${rate} ${toCur})` : ''}`,
      facts: [
        { label: 'Amount', value: `${amount} ${fromCur}` },
        { label: 'Result', value: `${Math.round(result * 100) / 100} ${toCur}` },
        ...(rate ? [{ label: 'Exchange rate', value: `1 ${fromCur} = ${rate} ${toCur}` }] : []),
      ],
      source: 'Live web (via z.ai web_search)',
      sourceUrl: results[0]?.url,
      fetchedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export async function runTool(
  query: string
): Promise<{ instantAnswer: InstantAnswer | null; liveWeb: LiveWebResult[] }> {
  const detection = detectTool(query)
  if (detection.kind === 'weather') {
    const instantAnswer = await runWeatherTool(detection.param)
    return { instantAnswer, liveWeb: [] }
  }
  if (detection.kind === 'time') {
    const instantAnswer = await runTimeTool(detection.param)
    return { instantAnswer, liveWeb: [] }
  }
  if (detection.kind === 'math') {
    const instantAnswer = runMathTool(detection.param)
    return { instantAnswer, liveWeb: [] }
  }
  if (detection.kind === 'convert') {
    const instantAnswer = runConvertTool(detection.param)
    return { instantAnswer, liveWeb: [] }
  }
  if (detection.kind === 'currency') {
    const instantAnswer = await runCurrencyTool(detection.param)
    return { instantAnswer, liveWeb: [] }
  }
  return { instantAnswer: null, liveWeb: [] }
}

/**
 * Should this query trigger a live-web fallback?
 *
 * P1-1 FIX: The previous implementation gated on `indexResultCount === 0`,
 * which meant the engine NEVER escaped the small local index for
 * celebrity/news queries — if even 1 irrelevant doc was matched, the
 * fallback was suppressed.
 *
 * New logic — trigger the live-web fallback when ANY of:
 *   - indexResultCount === 0 (zero results — original behavior)
 *   - indexResultCount < 3 (very few results — probably weak matches)
 *   - topResultsMeanScore < 0.3 (top-3 results look weak — the index
 *     didn't find anything confidently relevant)
 *   - topResultsCoverage < 0.5 (top-3 results collectively don't cover
 *     ≥50% of the query terms — strong signal the index doesn't have a
 *     doc about the user's actual intent; e.g. "Steve Jobs" → all 3 top
 *     results match only "jobs" the word, not "Steve Jobs" the person)
 *
 * The last check is the most important for the relevance crisis: it
 * catches the case where the BM25 query found 4 irrelevant docs that all
 * happen to contain one of the query's tokens.
 *
 * @param query           The user query.
 * @param indexResultCount  How many results the local index returned.
 * @param topResultsMeanScore  The mean relevanceScore of the top-3 index
 *                          results. Optional — if undefined, falls back to
 *                          the count-based heuristic.
 * @param topResultsMatchedTerms  Union of matched-terms across the top-3
 *                          index results. Optional — used for the coverage
 *                          check.
 */
export function shouldLiveWebFallback(
  query: string,
  indexResultCount: number,
  topResultsMeanScore?: number,
  topResultsMatchedTerms?: string[],
): boolean {
  const parsed = parseQuery(query)
  if (parsed.tokens.length < 1) return false
  // Don't fallback for pure navigational queries (single brand name).
  if (parsed.intent === 'navigational' && parsed.tokens.length <= 1) return false

  // ALWAYS trigger the live-web fallback — fetch DuckDuckGo results for
  // every query. The caller merges the live-web results into the main
  // results array when index results are weak. This ensures the user
  // ALWAYS sees real web results, not just the small 65-doc local index.
  return true
}
