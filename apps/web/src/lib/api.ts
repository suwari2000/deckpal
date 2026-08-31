// API client — consumes deckpal-api (read-only contract, API.md).
// Cloud: /api (Vercel). Self-host: /deckpal/api (behind nginx proxy).
//
// THIS FILE OWNS THE BASE PATH. Nothing else in apps/web may write an API path
// literal: the two deployments disagree about the prefix, so a hand-rolled
// `fetch('/deckpal/api/…')` works in exactly one of them and, in the other,
// lands on the SPA fallback — HTTP 200 with HTML, which sails past `res.ok`
// and dies in the JSON parser with a message that names nothing (see
// ./jsonContentType.ts, and issues #89 / #113 where that shipped). A caller
// with no method here should get one, not a fetch of its own.
// `apps/web/scripts/check-api-base.mjs` enforces this at build time.

import { isCloudMode } from './supabase'
import { readSession, refreshSessionBounded } from './authSession'
import { isPublicPathname } from './landingRoute'
import { isJsonContentType } from './jsonContentType'
import type { ValueRangeKey } from './insightsCaption'
import type { PriceGrain, PriceHistoryPoint } from './priceGrain'
import type { Goal } from '../routes/setSearch'

const BASE = isCloudMode ? '/api' : '/deckpal/api'

// EVERY request in the app went through an unbounded `getSession()` here, which
// is why issue #75 could empty the public catalog as well as blank the landing
// page: one stalled token refresh and no query anywhere ever fired. Bounded now
// — past the deadline the request goes out unauthenticated, and a 401 (a
// FINITE failure the UI can render) beats a spinner that never resolves. See
// lib/sessionDeadline.ts.
async function authHeaders(): Promise<Record<string, string>> {
  if (!isCloudMode) return {}
  const { session } = await readSession()
  if (!session) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

async function handle401(path: string, init: RequestInit): Promise<Response | null> {
  if (!isCloudMode) return null
  const { error, timedOut } = await refreshSessionBounded()
  // A refresh that never answered is NOT a rejected credential. Falling into
  // the branch below would hard-redirect to /auth — i.e. sign somebody out over
  // a bad connection. The caller gets an error it can show; the session is left
  // exactly where it was.
  if (timedOut) throw new Error('Session check timed out')
  if (error) {
    // Only hard-redirect when NOT already on a public page — otherwise
    // AppShell's ProfileChip (which fires an auth-required overview call)
    // creates an infinite location.assign → page-reload → 401 →
    // location.assign loop. Same predicate the router and shell use, so the
    // three can never disagree about which pages are safe to sit on.
    if (!isPublicPathname(window.location.pathname)) {
      // Literal '/auth': the !isCloudMode early return above means the
      // self-host arm of a mode ternary could never be taken here.
      window.location.assign('/auth')
    }
    throw new Error('Session expired')
  }
  const h = await authHeaders()
  return fetch(`${BASE}${path}`, { ...init, headers: { ...init.headers as Record<string, string>, ...h } })
}

/**
 * An API failure that still knows its HTTP status.
 *
 * ── WHY THE STATUS HAD TO COME BACK ──────────────────────────────────────────
 *
 * Every failure here used to be a bare `Error` carrying only a message, so a
 * caller that needed to tell "gone" from "broken" had no choice but to match on
 * the server's PROSE. Deck-E's history did exactly that —
 * `/no such conversation/i` — to show "this was deleted" instead of "something
 * went wrong", and that is a coupling to a sentence somebody will reword.
 *
 * `status` is the fact. The message stays exactly as it was, so nothing that
 * reads it changes, and `instanceof Error` still holds for everything that
 * catches broadly.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function extractError(res: Response): Promise<string> {
  return res.json().then(
    (b: { error?: { message?: string } }) => b?.error?.message ?? `HTTP ${res.status}`,
    () => `HTTP ${res.status}`,
  )
}

/** Build the error for a failed response, status included. */
async function apiError(res: Response): Promise<ApiError> {
  return new ApiError(await extractError(res), res.status)
}

/**
 * Parse a SUCCESSFUL response, refusing anything that is not JSON.
 *
 * A 2xx with an HTML body is the signature of "this deployment does not route
 * that path" — the SPA fallback answered instead of the API. `res.ok` cannot
 * see it and `res.json()` reports it as a parser syntax error with no context
 * (WebKit's is the notorious "The string did not match the expected pattern.").
 * Naming the path and the type that came back is the difference between a bug
 * report somebody can act on and one that reads as "the app is broken".
 *
 * The failure arm is an `ApiError` like every other failure here, so nothing
 * that already catches API failures needs to learn a new shape.
 */
async function jsonBody<T>(res: Response, path: string): Promise<T> {
  const contentType = res.headers.get('content-type')
  if (!isJsonContentType(contentType)) {
    throw new ApiError(
      `${BASE}${path} answered ${res.status} with ${contentType ?? 'no content type'} instead of JSON — ` +
        'this build is asking for an API path the deployment does not serve.',
      res.status,
    )
  }
  return res.json() as Promise<T>
}

// The one fetch pipeline: request → single 401-refresh retry (handle401, which
// re-sends the same init with fresh auth headers) → ApiError on failure →
// parsed JSON. Callers own their init — headers, body, keepalive, signal — and
// this owns what happens to it. keepaliveJson stays off this path on purpose:
// it has no 401 retry (see its comment).
async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res = await fetch(`${BASE}${path}`, init)
  if (res.status === 401) {
    const retry = await handle401(path, init)
    if (retry) res = retry
  }
  if (!res.ok) throw await apiError(res)
  return jsonBody<T>(res, path)
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const headers = await authHeaders()
  return request<T>(path, { signal, headers })
}

async function send<T>(
  method: 'PATCH' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  // OPTIONAL, and the caller that needs it is a write. Deck-E's approval card
  // commits a corrected batch while the whole chat is frozen waiting on it —
  // busy, composer refusing input, both buttons disabled — so a stalled
  // connection there parks the panel with no way out but a reload. A deadline
  // is the difference between "this failed" and "this is still going".
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...await authHeaders() }
  return request<T>(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  })
}

/**
 * A POST that survives the page going away.
 *
 * ── WHY NOT `send()` ─────────────────────────────────────────────────────────
 *
 * The commonest end of a conversation is: read the answer, close the tab. A
 * plain `fetch` is cancelled with the document, so the request most likely to be
 * lost is the one recording the LAST exchange — the interesting end of every
 * session, missing from a feature whose whole value is completeness. Losing a
 * random middle record is tolerable and visible as a gap; losing the final one
 * every time is a silent bias in the data.
 *
 * `keepalive` hands the request to the browser to finish after unload. Its cost
 * is a hard 64KB budget shared by every in-flight keepalive request, so the body
 * is measured and TRIMMED to fit rather than being allowed to fail — a truncated
 * record of the last exchange beats no record of it.
 *
 * No 401 retry: `handle401` refreshes a session and re-fetches, which cannot
 * work once the document is gone. A record lost to an expired token is a warning
 * in the console, not a reason to build a retry that only runs when the page is
 * still open.
 */
const KEEPALIVE_BUDGET = 60_000

async function keepaliveJson<T>(path: string, body: unknown): Promise<T> {
  const h = await authHeaders()
  let payload = JSON.stringify(body)
  if (payload.length > KEEPALIVE_BUDGET) {
    // Trim the two free-text fields, longest first, and SAY that it happened —
    // an answer that stops mid-sentence with no explanation reads as a bug in
    // the thing being recorded rather than in the recording.
    const b = { ...(body as Record<string, unknown>) }
    const mark = '\n\n[TRUNCATED — this record exceeded the browser’s keepalive limit]'
    const room = Math.max(400, Math.floor(KEEPALIVE_BUDGET / 2) - mark.length)
    for (const k of ['answered', 'asked']) {
      const v = b[k]
      if (typeof v === 'string' && v.length > room) b[k] = v.slice(0, room) + mark
      payload = JSON.stringify(b)
      if (payload.length <= KEEPALIVE_BUDGET) break
    }
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json', ...h },
    body: payload,
  })
  if (!res.ok) throw await apiError(res)
  return jsonBody<T>(res, path)
}

/**
 * POST raw bytes (an image file) rather than JSON.
 *
 * `application/octet-stream` is deliberate: the server decides the real type
 * from the file's magic bytes and ignores this header entirely, and declaring
 * octet-stream keeps the API's app-wide `express.json` parser from trying to
 * consume the body first. A `Blob` body survives the 401-refresh retry because
 * a Blob can be read more than once — a ReadableStream could not.
 */
async function upload<T>(path: string, blob: Blob): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', ...await authHeaders() }
  return request<T>(path, { method: 'POST', headers, body: blob })
}

// ── Profile photo ──────────────────────────────────────────────
// `enabled` is false on a self-host deployment, which has no object store —
// the UI hides the whole control rather than offering something that 501s.
export interface AvatarState {
  avatarUrl: string | null
  enabled: boolean
  /** Largest upload the server will accept, in bytes. */
  maxBytes?: number
  /** Formats accepted, decided server-side by magic bytes. */
  accept?: string[]
}

// ── Personal access tokens ─────────────────────────────────────
// Long-lived bearer credentials for non-browser clients (the /mcp endpoint,
// scripts). The raw value is returned once by createApiToken and never again;
// `prefix` is all the server can show afterwards.
export interface ApiTokenRow {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

// ── Money ──────────────────────────────────────────────────────
// Prices are objects: null means "no price" → render "—", never $0.
export interface Price {
  market: number | null
  currency: string
}

export interface VariantPrice {
  source: string
  sourceLabel?: string
  marketplace?: string
  currency: string
  market: number | null
  low: number | null
  mid: number | null
  high: number | null
  pricedAt: string | null
  isFallback: boolean
}

// ── Scanner (Phase 8 — perceptual-hash image → card matcher) ───
// POST /scan takes the RAW image bytes with an image/* Content-Type (never
// multipart, never JSON), so it bypasses the shared json() helpers above.
export interface ScanMatch {
  cardId: string
  name: string
  number: string
  setId: string
  setName: string
  rarity: string | null
  images: { low: string; high: string }
  distance: number
  confidence: number
}
export interface ScanResponse {
  query: { algo: string; hash: string }
  matched: boolean
  threshold: number
  indexSize: number
  matches: ScanMatch[]
  note?: string
}

export interface FamilyAiQuota {
  enabled: boolean
  model: string
  limit: number
  used: number
  reserved: number
  bonusRemaining: number
  remaining: number
  resetsAt: string
}

export interface FamilyAiUsage {
  settings: { enabled: boolean; defaultDailyLimit: number; warningPercent: number }
  memberLimits: { userId: string; dailyLimit: number | null; bonusRemaining: number }[]
  rows: {
    user_id: string
    username: string
    usage_day: string
    succeeded: number
    failed: number
    input_tokens: number
    output_tokens: number
    estimated_cost_microusd: string
  }[]
}

export interface FamilyPriceSuggestion {
  id: string
  cardVariantId: string
  cardId: string
  cardName: string
  cardNumber: string
  setName: string
  variantName: string | null
  proposedBy: string
  proposerName: string
  amountMinor: number
  currencyCode: string
  sourceName: string
  sourceUrl: string | null
  condition: 'NM' | 'LP' | 'MP' | 'HP' | 'DMG'
  observedOn: string
  notes: string | null
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  decisionNote: string | null
  createdAt: string
}

export type ApprovedFamilyPrice = FamilyPriceSuggestion & { status: 'approved' }

export interface DeckImportPreview {
  source: 'ptcgl' | 'massentry'
  format: DeckFormat
  total: number
  resolved: { cardId: string; name: string; number: string; setId: string; quantity: number; resolution?: string }[]
  unresolved: string[]
  warnings: { code: string; message: string }[]
  variantNote: string
}

export interface FamilyCollectionImportPreview {
  fingerprint: string
  errors: { row: number; message: string }[]
  matched: { cardId: string; finish: string; quantity: number; condition: string; variantId: number; variantName: string }[]
  ambiguous: { cardId: string; finish: string; quantity: number; condition: string; candidates: { variantId: number; variantName: string }[] }[]
  unresolved: { cardId: string; finish: string; quantity: number; condition: string; reason: string }[]
}

export interface AiScanResponse extends ScanResponse {
  recognition: {
    name: string
    setName?: string | null
    collectorNumber?: string | null
    language?: string | null
    confidence: number
  }
  quota: { remaining: number }
  privacy: { imageStored: false }
}

// Response of POST /collection/cards/:cardId/have (tile-level Have/Need toggle).
export interface HaveMutationResponse {
  cardId: string
  setId: string
  card: {
    cardId: string
    variants: { variantId: number; quantity: number }[]
    ownership: { totalQuantity: number; have: boolean; need: boolean; dupe: boolean }
  }
  progress: Progress
}

// ── Series ─────────────────────────────────────────────────────
export interface SeriesSummary {
  slug: string
  tcgdexId: string
  name: string
  firstReleaseOn: string | null
  sortOrder: number
  setCount: number
  cardCount: number
  repSetId: string | null
  // A series whose sets have no upstream logo at all still gets a rep set, picked
  // by symbol — these two flags say which asset actually exists (issue #15).
  repHasLogo: boolean
  repHasSymbol: boolean
  // Per-series completion rollup: owned cards / total cards across the series.
  // OPTIONAL because the catalog is browsable signed-out — the API omits every
  // ownership field for an anonymous read rather than sending zeroes, and the
  // optionality is what forces each call site to say what it renders instead.
  progress?: { owned: number; total: number; pct: number }
}
export interface SeriesIndexResponse {
  series: SeriesSummary[]
}

export interface GoalProgress {
  owned: number
  total: number
  pct: number
  totalQuantity?: number
  setLevel?: number
}
export interface Progress {
  complete: GoalProgress
  master: GoalProgress
  grandmaster: GoalProgress
}

export interface SetSummary {
  setId: string
  slug: string
  name: string
  releasedOn: string | null
  isPromo: boolean
  printedCount: number
  secretCount: number
  cardCountTotal: number
  logoUrl: string | null
  symbolUrl: string | null
  /** Absent for an anonymous read (see SeriesSummary.progress). */
  progress?: Progress
}
export interface SeriesDetailResponse {
  series: { slug: string; tcgdexId: string; name: string; firstReleaseOn: string | null }
  sets: SetSummary[]
}

// ── Set detail ─────────────────────────────────────────────────
export interface CardOwnership {
  totalQuantity: number
  requiredCount: number
  ownedRequired: number
  have: boolean
  need: boolean
  dupe: boolean
}
/** The slice of a variant the set grid's count boxes render. */
export interface TileVariant {
  variantId: number
  kind: string
  displayName: string
  tier: 'standard' | 'special'
  /** Owned count. Absent for an anonymous read. */
  quantity?: number
}
export interface CardRow {
  cardId: string
  number: string
  numberSort: string
  name: string
  category: string
  rarity: string | null
  artist: string | null
  variantCount: number
  images: { low: string; high: string }
  price: Price | null
  /** Absent for an anonymous read (see SeriesSummary.progress). */
  ownership?: CardOwnership
  // Standard-tier variants with owned quantities, served inline by /sets/:setId so
  // the grid's count boxes need no per-tile request. Absent on endpoints that
  // don't supply it (lists, search), where the tiles fall back to GET /cards/:id.
  standardVariants?: TileVariant[]
  // Optional per-card routing (present on list items, which span many sets).
  seriesSlug?: string | null
  setId?: string | null
  // The SPECIFIC printing this row is about, present on list items only.
  //
  // A list stores `list_item.card_variant_id`, so it has always known whether
  // you added the Holofoil or the Reverse — it just never said so, and showed
  // the catalogue's `+N Variants` badge instead, which answers a different
  // question ("this card has N other printings in existence"). Two variants of
  // one card are two separate rows in the same list, and before 2026-08-29 they
  // rendered as two identical-looking tiles.
  //
  // Declared on CardRow rather than only on ListItem because the tile, the
  // table row and the binder slot all receive `CardRow` and all three need to
  // render it; `ListItem extends CardRow`, so the field already flowed here at
  // runtime and was merely invisible to the type.
  variant?: { kind: string | null; displayName: string | null; tier: string | null; isPrimary: boolean | null }
}
export interface SetDetailResponse {
  set: {
    setId: string
    slug: string
    name: string
    series: { slug: string; name: string; tcgdexId: string }
    releasedOn: string | null
    isPromo: boolean
    printedCount: number
    secretCount: number
    cardCountTotal: number
    images: { logoUrl: string | null; symbolUrl: string | null; backgroundUrl: string | null }
    marketValueUsd: number | null
    mostExpensiveCard: { cardId: string; name: string; number: string; marketUsd: number | null } | null
  }
  /** Absent for an anonymous read (see SeriesSummary.progress). */
  progress?: Progress
  query: Record<string, unknown>
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
  cards: CardRow[]
}

// ── Card detail ────────────────────────────────────────────────
export interface Variant {
  variantId: number
  kind: string
  displayName: string
  provenance: string | null
  tier: 'standard' | 'special'
  tierSource?: string
  isPrimary: boolean
  isSynthesized?: boolean
  source: string
  /** Owned count. Absent for an anonymous read. */
  quantity?: number
  buyUrl: string | null
  prices: VariantPrice[]
}
export interface CardDetailResponse {
  card: {
    cardId: string
    number: string
    printedTotal: number | null
    name: string
    category: string
    rarity: string | null
    artist: string | null
    hp: number | null
    stage: string | null
    evolvesFrom: string | null
    retreat: number | null
    regulationMark: string | null
    releasedOn: string | null
    set: { setId: string; name: string; slug: string; logoUrl: string | null; symbolUrl: string | null }
    series: { slug: string; name: string; tcgdexId: string }
    images: { low: string; high: string }
    types: string[]
    subtypes: string[]
    tags: string[]
    attacks: { name: string; cost: string | null; damage: string | null; effect: string | null }[]
    abilities: { name: string; effect: string | null }[]
    weaknesses: { type: string; value: string }[]
    resistances: { type: string; value: string }[]
    species: { speciesId: number; slug: string; name: string; generation: number }[]
  }
  variants: Variant[]
}

/** Per-card format eligibility — GET /cards/:cardId/legality. */
export interface CardLegalityResponse {
  /** The vendored legality data's own 'as of' date. */
  checkedAt: string
  formats: { format: 'standard' | 'expanded' | 'glc' | 'unlimited'; legal: boolean; reasons: string[] }[]
}

// One definition of the point shape — priceGrain.ts owns it (that module stays
// runtime-import-free); these re-exports keep every import site pointing here.
export type { PriceGrain, PriceHistoryPoint }

/**
 * Observed market price over time, one series per printing, at whatever GRAIN
 * that stretch of history still exists in.
 *
 * The points used to be `{date, value}`. Since the retention tiers landed
 * (migration 048) history is kept daily for ~30 days, weekly for ~6 months and
 * monthly forever, so every point carries the full OHLC bucket and a `grain`
 * saying which tier it came from. A DAY is a degenerate bucket —
 * `open = high = low = close`, `start = end = highOn = lowOn`, `n = 1` — so a
 * caller that only wants a line reads `close` and never branches on grain.
 *
 * The endpoint's JSDoc carries the contract for what may be ASSERTED from a
 * bucket; it matters here too, because this type is what an agent tool would
 * eventually be built on.
 */
export interface CardPriceHistoryResponse {
  currency: string
  range: ValueRange
  series: {
    variantId: number
    kind: string
    displayName: string
    tier: string | null
    points: PriceHistoryPoint[]
  }[]
}

export interface CollectionBatchResponse {
  batchId: string
  replayed: boolean
  applied: number
  unchanged: number
  items: { variantId: number; cardId: string; before: number; after: number; clamped: boolean }[]
}

// ── Collection mutations (write API) ───────────────────────────
// The set of quantities changes; the server recomputes the affected set's three
// progress goals in the same transaction and returns them authoritatively.
export interface CollectionMutationResponse {
  variantId: number
  quantity: number
  delta: number
  isFirstAcquisition: boolean
  card: {
    cardId: string
    variants: { variantId: number; quantity: number }[]
    ownership: { totalQuantity: number; have: boolean; need: boolean; dupe: boolean }
  }
  setId: string
  progress: Progress
}

// ── Lists ──────────────────────────────────────────────────────
export type ListKind = 'dynamic' | 'static' | 'pokedex_binder'
export type ListVisibility = 'private' | 'public'

export interface ListProgress {
  owned: number
  total: number
  pct: number
  copies: number
}
/**
 * A smart list's saved query (migration 050) — the addMissing spec plus
 * hand-exclusions. Present on a rule-backed dynamic list; null/absent on a
 * reference list. `setName` is resolved server-side for display.
 */
export interface ListRule {
  setId: string
  setName: string | null
  goal: 'complete' | 'master' | 'grandmaster'
  finishes: string[] | null
  rarity: string[] | null
  rarityExclude: string[] | null
  maxPriceUsd: number | null
  pricedOnly: boolean
  /** card_variant ids removed by hand ("remove" on a smart list excludes). */
  exclude: number[]
}

export interface ListSummary {
  id: string
  kind: ListKind
  name: string
  description: string | null
  visibility: ListVisibility
  isFavorite: boolean
  coverRender: string
  pocketSize: number | null
  itemCount: number
  progress: ListProgress | null
  marketValueUsd: number | null
  coverImage: { low: string; high: string } | null
  /** Up to 8 distinct cards for the index tile's mosaic, cover pick first. */
  coverImages: { low: string; high: string }[]
  /** Present on a smart list; null on a reference/static/binder list. */
  rule: ListRule | null
  ruleEvaluatedAt: string | null
  createdAt: string
  updatedAt: string
}
// A resolved list row. Extends CardRow so GridView/BinderView/TableView render it
// directly; the extra fields carry list identity + read-through/static quantities.
export interface ListItem extends CardRow {
  itemId: string
  position: number
  itemKind: 'card' | 'species'
  variantId?: number | null
  variant?: { kind: string | null; displayName: string | null; tier: string | null; isPrimary: boolean | null }
  setName?: string | null
  note?: string | null
  staticQuantity?: number | null
  ownedQuantity?: number
  dexId?: number
  generation?: number | null
}
export interface ListDetailResponse {
  list: ListSummary
  items: ListItem[]
  /** Smart lists only: the cards removed by hand, for un-excluding. */
  excluded?: { variantId: number; cardId: string; name: string; number: string }[]
}
export interface CreateListBody {
  name: string
  kind: ListKind
  description?: string | null
  visibility?: ListVisibility
  /** Making it a smart list: the saved query (kind must be 'dynamic'). */
  rule?: Partial<ListRule> | null
}
export interface UpdateListBody {
  name?: string
  description?: string | null
  visibility?: ListVisibility
  isFavorite?: boolean
  itemOrder?: string[]
  coverCardVariantId?: number | null
  /** Replace the smart list's rule; null PINS it (materialises the current
   *  evaluation into stored rows and detaches the rule). */
  rule?: Partial<ListRule> | null
}

// ── Search (used by the Add-to-List picker) ────────────────────
export interface SearchCard {
  cardId: string
  number: string
  name: string
  category: string
  rarity: string | null
  artist: string | null
  regulationMark?: string | null
  set: { setId: string; name: string }
  series: { slug: string; name: string }
  variantCount: number
  images: { low: string; high: string }
  price: Price | null
}
export interface SearchResponse {
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
  cards: SearchCard[]
}

// ── Decks (Phase 5) ────────────────────────────────────────────
export type DeckFormat = 'standard' | 'expanded' | 'glc' | 'unlimited'

export interface BattleRecord {
  wins: number
  losses: number
  ties: number
}
export interface DeckSummary {
  id: string
  name: string
  description: string | null
  formatCode: DeckFormat
  formatName: string
  glcType: string | null
  isFavorite: boolean
  coverRender: string
  coverImage: { low: string; high: string } | null
  version: number
  totalCount: number
  valueUsd: number | null
  legal: boolean
  createdAt: string
  updatedAt: string
  // Aggregate battle record over ALL versions — present on GET /decks rows only.
  record?: BattleRecord
}
export interface DeckCard {
  cardId: string
  /** Which PRINTING this row is (migration 051) — one row per variant now. */
  variantId: number
  variant: { kind: string | null; displayName: string | null; tier: string | null; isPrimary: boolean | null } | null
  name: string
  number: string
  numberSort: string | null
  category: string
  section: 'pokemon' | 'trainer' | 'energy'
  stage: string | null
  rarity: string | null
  artist: string | null
  regulationMark: string | null
  setId: string
  /** Expansion code printed on the card itself ("PBL"); null when the set has none. */
  setCode: string | null
  setName: string
  seriesSlug: string
  quantity: number
  owned: number
  have: boolean
  images: { low: string; high: string }
  price: Price | null
}
export interface DeckCounts {
  total: number
  pokemon: number
  trainer: number
  energy: number
  distinctNames: number
}
export interface Violation {
  code: string
  severity: 'error' | 'warning'
  rule: string
  message: string
  scope: string
  subject?: string
  card_ids?: number[]
  observed?: number
  allowed?: number
  delta?: number
  detail?: Record<string, unknown>
}
export interface ValidationWarning {
  code: string
  message: string
}
export interface ValidationResult {
  format: DeckFormat
  format_data_checked_at: string
  legal: boolean
  counts: { total: number; pokemon: number; trainer: number; energy: number; distinct_names: number; unresolved: number }
  violations: Violation[]
  warnings: ValidationWarning[]
}
export interface CardRef {
  cardId: string
  name: string
  number: string
  setId: string
  seriesSlug: string
  image: string
}
export interface DeckDetail {
  deck: DeckSummary & { strategyMd: string | null }
  counts: DeckCounts
  cards: DeckCard[]
  validation: ValidationResult
  cardRefs: Record<string, CardRef>
  glcTypes: string[]
  import?: {
    source: string
    resolvedEntries: number
    distinctCards: number
    unresolved: string[]
    warnings: ValidationWarning[]
  }
}
export interface HandCard {
  cardId: string | null
  name: string
  number: string | null
  category: string | null
  isBasicPokemon: boolean
  image: string | null
}
export interface TestHand {
  seed: number
  deckSize: number
  basicPokemonCount: number
  mulligans: number
  opponentDraws: number
  mulliganChancePct: number
  hand: HandCard[]
  prizes: HandCard[]
  note: string
}
export interface MissingCard {
  cardId: string
  name: string
  number: string
  setId: string
  missingQty: number
  unitPrice: number | null
  lineTotal: number | null
  buyUrl: string | null
  massEntry: string
  image: string
}
export interface DeckPricing {
  currency: string
  totalUsd: number | null
  ownedValueUsd: number | null
  missingValueUsd: number | null
  cards: { cardId: string; name: string; number: string; setId: string; quantity: number; owned: number; unitPrice: number | null; lineTotal: number | null; currency: string }[]
  missing: MissingCard[]
  massEntryText: string
}
/**
 * GET /sets/:setId/massentry — TCGplayer cart deep links for everything still
 * needed to finish a set at a goal. Per-user, so it is authenticated.
 *
 * Same shape family as {@link DeckMassEntry}; the extra fields are the echo of
 * what was carted (`source`, `set`, `goal`, `finishes`, the rarity filters) so
 * a caller can tell a set cart from a list cart without inspecting its own
 * request. See `apps/api/src/routes/massentry.ts` → `cartPayload`.
 */
export interface SetMassEntry {
  source: 'set'
  set: { setId: string; name: string }
  goal: Goal
  /** `null` means every finish counts — the server normalises a full selection to null. */
  finishes: string[] | null
  rarity: string[] | null
  rarityExclude: string[] | null
  /** `cards` counts distinct Mass Entry LINES, not distinct cards (kept from the original shape). */
  needed: { cards: number; items: number; unlinkable: number; exactLines: number; bestEffortLines: number }
  lines: string[]
  text: string
  urls: string[]
  exactUrls: string[]
  bestEffortUrls: string[]
  unlinkable: { name: string; number: string; setId: string; variant: string | null }[]
  warnings: string[]
  note: string
}

// GET /decks/:id/massentry — TCGplayer cart deep links for the missing cards
// (same shape family as GET /sets/:setId/massentry).
export interface DeckMassEntry {
  deck: { id: string; name: string }
  needed: { cards: number; items: number; unlinkable: number }
  lines: string[]
  text: string
  urls: string[]
  unlinkable: { name: string; number: string; setId: string; variant: string | null }[]
  warnings: string[]
  note: string
}
export interface CreateDeckBody {
  name: string
  formatCode?: DeckFormat
  glcType?: string | null
  description?: string | null
}

// ── Deck intelligence: versions, strategy, battle logs ─────────
// Per-version battle-log aggregate (`total` includes result-less logs).
export interface VersionBattleRecord extends BattleRecord {
  total: number
}
export interface DeckVersionSummary {
  version: number
  note: string | null
  source: string
  createdAt: string
  cardCount: number
  formatCode: DeckFormat
  battleLogs: VersionBattleRecord
  isCurrent: boolean
}
export interface DeckVersionsResponse {
  current: number
  versions: DeckVersionSummary[]
}
export interface SnapshotCard {
  cardId: number
  tcgdexId: string
  name: string
  quantity: number
  /** Which printing (migration 051). Absent on pre-051 snapshots. */
  variantId?: number
  variantName?: string | null
}
export interface DeckVersionDiff {
  added: { name: string; tcgdexId: string; quantity: number }[]
  removed: { name: string; tcgdexId: string; quantity: number }[]
  changed: { name: string; tcgdexId: string; from: number; to: number }[]
  /** Same card, same total, different printing mix — e.g. "2× Normal" →
   *  "1× Normal + 1× Reverse Holofoil". Absent from pre-051 responses. */
  printings?: { name: string; tcgdexId: string; from: string; to: string }[]
}
export interface DeckVersionDetail {
  version: number
  isCurrent: boolean
  formatCode: DeckFormat
  note: string | null
  source: string
  createdAt: string
  strategyMd: string | null
  cardCount: number
  cards: SnapshotCard[]
  battleLogs: VersionBattleRecord
  diff: DeckVersionDiff | null // null for v1 (nothing to diff against)
}
export interface RevertResult {
  toVersion: number
  version: number
  bumped: boolean
  skippedCards: { cardId: number; tcgdexId: string; name: string }[]
}
export type BattleResult = 'win' | 'loss' | 'tie'
export interface BattleLogSummary {
  id: number
  deckVersion: number
  result: BattleResult | null
  opponent: string | null
  opponentDeck: string | null
  turns: number | null
  prizes: { me: number; opponent: number } | null
  notes: string | null
  playedAt: string
  source: string
}
export interface ParsedBattleLog {
  players: { me: string | null; opponent: string | null }
  confidence: 'high' | 'low'
  result: BattleResult | null
  wentFirst: 'me' | 'opponent' | null
  totalTurns: number
  prizesTaken: { me: number; opponent: number }
  knockouts: { byMe: string[]; byOpponent: string[] }
  opponentPokemon: string[]
  myPokemon: string[]
  opponentDeckGuess: string | null
}
export interface BattleLog extends BattleLogSummary {
  rawLog: string
  parsed: ParsedBattleLog | null
  createdAt: string
}
export interface BattleLogsResponse {
  version: number | null
  logs: BattleLogSummary[]
  totals: VersionBattleRecord
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
}
export interface AddBattleLogBody {
  rawLog: string
  result?: BattleResult
  opponent?: string
  opponentDeck?: string
  notes?: string
  playedAt?: string
  playerName?: string
}
export interface UpdateDeckBody {
  name?: string
  description?: string | null
  formatCode?: DeckFormat
  glcType?: string | null
  isFavorite?: boolean
  coverRender?: string
}

// ── Insights / gamification (Phase 6) ──────────────────────────
// All read-only, over /insights/*. Shapes mirror apps/api/src/insights/*.
export interface TrainerLevel {
  level: number
  uniqueCards: number
  intoLevel: number
  toNext: number
  nextLevelAt: number
  fraction: number
  uniqueMode: 'cards' | 'pairs'
  totalCards: number
  uniquePairs: number
}
export interface CurrencyTotal {
  currency: string
  totalMinor: number
  total: number
  pricedVariants: number
  quantity: number
}
export interface InsightsOverview {
  trainer: TrainerLevel
  collectionValue: CurrencyTotal[]
  pokedex: { captured: number; total: number; pct: number }
}
export interface MeResponse {
  userId?: string
  username: string
  /** True when this account may open /design in production (owner only).
   *  Retained for that gate; new surfaces should read `owner`. */
  designEditor?: boolean
  /** True when this account is the deployment's owner. Server-verified against
   *  the JWT — the owner's identity never enters this bundle. */
  owner?: boolean
  /**
   * True when this account may use Deck-E.
   *
   * A SEPARATE ANSWER FROM `owner`, and it has to be. `POST /api/chat` gates on
   * the owner PLUS `DECKE_ENTITLED_USER_IDS`, so reusing `owner` here made the
   * two gates disagree: the server would answer a turn for an entitled
   * non-owner while the browser refused to draw them a button. Found on the
   * deployed preview, where the QA account was entitled server-side and Deck-E
   * was invisible — which would have made every browser gate unrunnable by the
   * only account permitted to run them (B12).
   *
   * Computed server-side from the same function the endpoint uses, so the two
   * cannot drift again.
   */
  decke?: boolean
  family?: FamilyContext | null
}

export interface FamilyContext {
  familyId: string
  familyName: string
  role: 'admin' | 'member'
  status: 'invited' | 'active' | 'disabled'
}

export interface FamilyMemberSummary {
  userId: string
  username: string
  displayName: string | null
  role: 'admin' | 'member'
  status: 'invited' | 'active' | 'disabled'
  joinedAt: string | null
  uniqueCards: number
  totalQuantity: number
}

export interface FamilyCollectionItem {
  id: string
  cardVariantId: string
  cardId: string
  cardTcgdexId: string
  cardName: string
  number: string
  variantName: string | null
  setName: string
  quantity: number
  condition: string | null
  updatedAt: string
  images: { low: string; high: string }
}

export interface FamilyCollectionPage {
  ownerUserId: string
  items: FamilyCollectionItem[]
  nextCursor: string | null
}

export interface FamilyInvitation {
  id: string
  email: string
  role: string
  status: string
  expiresAt: string
  createdAt?: string
}
/**
 * The account's settings row (user_settings + migration 049's UI columns).
 * `skin`/`topbar` are null when the account never chose — the app default
 * applies. See lib/settingsSync.ts for how these meet the localStorage caches.
 */
export interface UserSettings {
  defaultGoal: 'complete' | 'master' | 'grandmaster'
  displayCurrency: string
  pricingEnabled: boolean
  showCollectionValue: boolean
  binderPocketSize: 4 | 9 | 12 | 16
  binderStackVariants: boolean
  binderAdditionalVariants: 'hide' | 'inline' | 'end'
  deckeHidden: boolean
  skin: 'premium' | 'classic' | null
  topbar: 'cover' | 'flat' | null
  seriesSortKey: 'recency' | 'az' | 'pct'
  seriesSortDir: 'asc' | 'desc'
  seriesGroupOwned: boolean
}

/** One featured card on the profile (user_showcase; slot is 1-based). */
export interface ShowcaseSlot {
  slot: number
  cardId: string
  name: string
  images: { low: string; high: string }
}

export interface CollectionEvent {
  eventId: string
  occurredAt: string
  kind: string
  cardId: string
  cardName: string
  setId: string
  setName: string
  number: string
  variantId: number
  variantName: string
  quantityDelta: number
  newQuantity: number
  images: { low: string | null; high: string | null }
}
export interface CollectionEventsResponse {
  events: CollectionEvent[]
}
// One definition of the range union — insightsCaption.ts owns it (that module
// stays runtime-import-free); this re-export keeps every existing import site.
export type ValueRange = ValueRangeKey
export interface ValuePoint {
  date: string
  value: number
  valueMinor: number
}
export interface ValueDelta {
  valueMinor: number
  value: number
  pct: number | null
}
export interface ValueSeriesData {
  currency: string
  range: ValueRange
  points: ValuePoint[]
  delta: ValueDelta | null
}
export interface Mover {
  cardId: string
  variantKind: string
  name: string
  currency: string
  quantity: number
  market: number
  change: number
  changePct: number | null
}
export interface ValueResponse {
  currency: string
  range: ValueRange
  current: CurrencyTotal
  series: ValueSeriesData
  movers: Mover[]
}
export interface SpeciesSprite {
  pixel: string
  pixelShiny: string
  art: string
  artShiny: string
}
export interface SpeciesGridRow {
  speciesId: number
  slug: string
  name: string
  genus: string | null
  generation: number
  types: string[]
  cardPool: number
  // Capture state is the caller's; absent for an anonymous read.
  uniqueOwned?: number
  captured?: boolean
  level?: number
  levelLabel?: string
  shiny?: boolean
  shinyBreadth?: number
  sprite: SpeciesSprite
}
export interface SpeciesGridResponse {
  completion?: { captured: number; total: number }
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
  species: SpeciesGridRow[]
}
export interface SpeciesDetailCard {
  cardId: string
  number: string
  name: string
  category: string
  rarity: string | null
  artist: string | null
  set: { setId: string; name: string }
  variantCount: number
  owned?: boolean
  ownedQuantity?: number
  images: { low: string; high: string }
  price: Price | null
}
export interface SpeciesDetailResponse {
  species: {
    speciesId: number
    slug: string
    name: string
    genus: string | null
    generation: number
    types: string[]
    cardPool: number
    uniqueOwned?: number
    captured?: boolean
    level?: number
    levelLabel?: string
    shiny?: boolean
    shinyBreadth?: number
    sprite: SpeciesSprite
  }
  cards: SpeciesDetailCard[]
}

// The raw item shape the API returns before we normalise `kind` → `itemKind`.
interface RawListItem extends Omit<ListItem, 'itemKind'> {
  kind: 'card' | 'species'
}
function normaliseItems(r: { list: ListSummary; items: RawListItem[] }): ListDetailResponse {
  return { list: r.list, items: r.items.map(({ kind, ...rest }) => ({ ...rest, itemKind: kind })) }
}

// ── Endpoints ──────────────────────────────────────────────────
/** One row in the history dropdown. */
export interface DeckeConversationSummary {
  id: string
  title: string
  turns: number
  startedAt: string
  updatedAt: string
  /**
   * The PR range this conversation ran across.
   *
   * They differ when a conversation outlived a deploy, which is exactly the
   * conversation worth opening when something changed. `null` on both means no
   * turn in it was attributable to a PR — a preview build or a local run.
   */
  buildPrMin: number | null
  buildPrMax: number | null
  buildSha: string | null
}

export interface DeckeHistoryList {
  conversations: DeckeConversationSummary[]
}

/** One recorded exchange: what was asked, what came back, and what ran. */
export interface DeckeHistoryTurn {
  seq: number
  asked: string
  answered: string
  /** `phase` is the chip's own word — ok, partial, error, declined, unknown. */
  tools: { name: string; phase: string; title: string; summary: string }[]
  buildPr: number | null
  buildSha: string | null
  at: string
}

export interface DeckeConversation {
  id: string
  title: string
  startedAt: string
  turns: DeckeHistoryTurn[]
}

export const api = {
  // ── DECK-E'S TRANSCRIPT HISTORY ───────────────────────────────────────────
  //
  // Gated server-side to the accounts that have Deck-E at all, so every one of
  // these throws for anybody else rather than returning an empty list — an
  // empty list would claim the feature exists for you and you simply have not
  // used it.
  deckeHistoryRecord: (body: {
    conversationId: string
    seq: number
    asked: string
    answered: string
    tools: {
      name: string
      phase: string
      title: string
      summary: string
      /** What the call carried, already bounded server-side. See `decke/toolArgs.ts`. */
      args?: Record<string, unknown>
    }[]
    /** Why the last leg stopped. Absent means the server did not say. */
    finishReason?: string
  }) => keepaliveJson<{ ok: true; recorded: boolean }>('/decke/history', body),
  deckeHistoryList: (signal?: AbortSignal) =>
    get<DeckeHistoryList>('/decke/history', signal),
  deckeHistoryOne: (id: string, signal?: AbortSignal) =>
    get<DeckeConversation>(`/decke/history/${encodeURIComponent(id)}`, signal),
  deckeHistoryDelete: (id: string) =>
    send<{ ok: true }>('DELETE', `/decke/history/${encodeURIComponent(id)}`),

  series: (signal?: AbortSignal) => get<SeriesIndexResponse>('/series', signal),
  seriesDetail: (slug: string, signal?: AbortSignal) =>
    get<SeriesDetailResponse>(`/series/${encodeURIComponent(slug)}`, signal),
  set: (setId: string, params: URLSearchParams, signal?: AbortSignal) =>
    get<SetDetailResponse>(`/sets/${encodeURIComponent(setId)}?${params.toString()}`, signal),
  /**
   * A TCGplayer cart deep link for everything still needed to finish a set.
   *
   * `finishes` is the variant scope for master/grandmaster; pass `null` (or the
   * full set of finishes, which the server normalises to null) to count every
   * printing. It is meaningless for `complete`, where any one printing finishes
   * a card, so callers pass null there.
   *
   * Route parity note: this is the SET twin of `deckMassEntry`, and it exists
   * because `PurchaseSetMenu` used to hand-roll the fetch — with the self-host
   * base path, no `Authorization` header and no 401 refresh, so the whole
   * feature was dead on cloud (#89, and #113 which is the user-visible half).
   */
  setMassEntry: (setId: string, goal: Goal, finishes: readonly string[] | null, signal?: AbortSignal) => {
    const params = new URLSearchParams({ goal })
    for (const f of finishes ?? []) params.append('finish', f)
    return get<SetMassEntry>(`/sets/${encodeURIComponent(setId)}/massentry?${params.toString()}`, signal)
  },
  card: (cardId: string, signal?: AbortSignal) =>
    get<CardDetailResponse>(`/cards/${encodeURIComponent(cardId)}`, signal),
  // Set an absolute owned quantity for a variant.
  setVariantQuantity: (variantId: number, quantity: number) =>
    send<CollectionMutationResponse>('PATCH', `/collection/variants/${variantId}`, { quantity }),
  // Adjust a variant's owned quantity by a signed delta (floors at 0).
  incrementVariant: (variantId: number, delta: number) =>
    send<CollectionMutationResponse>('POST', `/collection/variants/${variantId}/increment`, { delta }),
  // Tile-level Have/Need toggle by card id (owns/zeroes the primary variant).
  /**
   * MANY variants, ONE transaction — the endpoint a pack haul belongs in.
   *
   * The per-variant endpoints are the right shape for a stepper click and the
   * wrong one for a rip: called in a loop they cost ~0.65 s each, which put a
   * 99-item batch past the serverless wall clock and inflated quantities up to
   * 4x when the caller retried a request that had actually half-succeeded. See
   * `apps/api/src/routes/collection.ts` and `API.md`.
   */
  collectionBatch: (
    items: { variantId: number; delta?: number; quantity?: number; condition?: 'NM' | 'LP' | 'MP' | 'HP' | 'DMG' }[],
    opts: { source?: string; note?: string; idempotencyKey?: string; signal?: AbortSignal } = {},
  ) => {
    const { signal, ...rest } = opts
    return send<CollectionBatchResponse>('POST', '/collection/batch', { items, ...rest }, signal)
  },

  setCardHave: (cardId: string, have: boolean) =>
    send<HaveMutationResponse>('POST', `/collection/cards/${encodeURIComponent(cardId)}/have`, { have }),

  // Scanner — POST raw image bytes, get ranked perceptual-hash matches.
  scan: async (bytes: ArrayBuffer, contentType: string, k = 5, quality: 'low' | 'high' = 'low', signal?: AbortSignal): Promise<ScanResponse> => {
    const params = new URLSearchParams({ k: String(k), quality })
    const auth = await authHeaders()
    return request<ScanResponse>(`/scan?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'application/octet-stream', ...auth },
      body: bytes,
      signal,
    })
  },
  familyAiQuota: (signal?: AbortSignal) => get<FamilyAiQuota>('/family/ai/quota', signal),
  familyAiUsage: (signal?: AbortSignal) => get<FamilyAiUsage>('/family/ai/usage', signal),
  updateFamilyAiSettings: (settings: { enabled: boolean; defaultDailyLimit: number; warningPercent?: number }) =>
    send<{ settings: FamilyAiUsage['settings'] }>('PATCH', '/family/ai/settings', settings),
  updateFamilyMemberAiLimit: (userId: string, value: { dailyLimit: number | null; bonusRemaining: number }) =>
    send<{ member: { userId: string; dailyLimit: number | null; bonusRemaining: number } }>(
      'PATCH',
      `/family/members/${encodeURIComponent(userId)}/ai-limit`,
      value,
    ),
  familyManualPrices: (cardId: string, signal?: AbortSignal) =>
    get<{ prices: ApprovedFamilyPrice[] }>(`/family/cards/${encodeURIComponent(cardId)}/manual-prices`, signal),
  familyPriceSuggestions: (status: FamilyPriceSuggestion['status'] = 'pending', signal?: AbortSignal) =>
    get<{ suggestions: FamilyPriceSuggestion[] }>(`/family/prices/suggestions?status=${encodeURIComponent(status)}`, signal),
  proposeFamilyPrice: (body: {
    cardVariantId: number
    amountMinor: number
    currencyCode: string
    sourceName: string
    sourceUrl?: string | null
    condition: FamilyPriceSuggestion['condition']
    observedOn: string
    notes?: string | null
  }) => send<{ suggestion: FamilyPriceSuggestion }>('POST', '/family/prices/suggestions', body),
  decideFamilyPrice: (id: string, decision: 'approve' | 'reject', note?: string | null) =>
    send<{ suggestion: FamilyPriceSuggestion }>(
      'POST',
      `/family/prices/suggestions/${encodeURIComponent(id)}/${decision}`,
      { note: note ?? null },
    ),
  previewFamilyCollectionImport: (text: string) =>
    send<FamilyCollectionImportPreview>('POST', '/family/import/preview', { text }),
  scanWithAi: async (blob: Blob, signal?: AbortSignal): Promise<AiScanResponse> => {
    const auth = await authHeaders()
    return request<AiScanResponse>('/scan/ai', {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'image/jpeg',
        'X-Request-Id': crypto.randomUUID(),
        ...auth,
      },
      body: blob,
      signal,
    })
  },
  // PDF export URLs (streamed by the API; open in a new tab).
  deckPdfUrl: (id: string) => `${BASE}/decks/${encodeURIComponent(id)}/pdf`,
  listPdfUrl: (id: string) => `${BASE}/lists/${encodeURIComponent(id)}/pdf`,
  setChecklistPdfUrl: (setId: string) => `${BASE}/sets/${encodeURIComponent(setId)}/checklist.pdf`,

  // Lists
  lists: (signal?: AbortSignal) => get<{ lists: ListSummary[] }>('/lists', signal),
  /** The recycle bin: lists that were deleted but are still restorable (migration 038). */
  deletedLists: (signal?: AbortSignal) => get<{ lists: ListSummary[] }>('/lists?deleted=true', signal),
  list: async (id: string, signal?: AbortSignal) =>
    normaliseItems(await get<{ list: ListSummary; items: RawListItem[] }>(`/lists/${encodeURIComponent(id)}`, signal)),
  createList: (body: CreateListBody) => send<{ list: ListSummary }>('POST', '/lists', body),
  updateList: (id: string, body: UpdateListBody) => send<{ list: ListSummary }>('PATCH', `/lists/${encodeURIComponent(id)}`, body),
  /** Reversible by default; `purge` is the deliberate no-undo path. */
  deleteList: (id: string) => send<{ deleted: string; restorable: boolean }>('DELETE', `/lists/${encodeURIComponent(id)}`),
  purgeList: (id: string) => send<{ purged: string }>('DELETE', `/lists/${encodeURIComponent(id)}?purge=true`),
  restoreList: (id: string) => send<{ restored: string; list: ListSummary }>('POST', `/lists/${encodeURIComponent(id)}/restore`),
  addListItem: (id: string, body: { cardVariantId?: number; dexId?: number; staticQuantity?: number; note?: string }) =>
    send<{ itemId: string | null; alreadyPresent: boolean; list: ListSummary }>('POST', `/lists/${encodeURIComponent(id)}/items`, body),
  removeListItem: (id: string, itemId: string) =>
    send<{ deleted: string; list: ListSummary | null }>('DELETE', `/lists/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`),
  searchCards: (params: URLSearchParams, signal?: AbortSignal) =>
    get<SearchResponse>(`/search?${params.toString()}`, signal),

  /**
   * The collection activity log, newest first.
   *
   * It is an ACTIVITY FEED, not an owned-cards table — removals and
   * quantity-decreases appear alongside acquisitions, and a card bought a year
   * ago with no activity since will not appear at all. That makes it the wrong
   * answer to "what does this user own" and the right answer to "what did they
   * just add", which is the question Deck-E's stash flight asks. Callers that
   * want acquisitions must filter on `quantityDelta > 0`.
   */
  collectionEvents: (limit = 50, signal?: AbortSignal) =>
    get<CollectionEventsResponse>(`/collection/events?limit=${limit}`, signal),

  // Decks
  decks: (signal?: AbortSignal) => get<{ decks: DeckSummary[] }>('/decks', signal),
  /** The recycle bin: decks that were deleted but are still restorable (migration 038). */
  deletedDecks: (signal?: AbortSignal) => get<{ decks: DeckSummary[] }>('/decks?deleted=true', signal),
  deck: (id: string, signal?: AbortSignal) => get<DeckDetail>(`/decks/${encodeURIComponent(id)}`, signal),
  createDeck: (body: CreateDeckBody) => send<DeckDetail>('POST', '/decks', body),
  updateDeck: (id: string, body: UpdateDeckBody) => send<DeckDetail>('PATCH', `/decks/${encodeURIComponent(id)}`, body),
  /** Reversible by default; `purge` also destroys version history and battle logs. */
  deleteDeck: (id: string) => send<{ deleted: string; restorable: boolean }>('DELETE', `/decks/${encodeURIComponent(id)}`),
  purgeDeck: (id: string) => send<{ purged: string }>('DELETE', `/decks/${encodeURIComponent(id)}?purge=true`),
  restoreDeck: (id: string) => send<{ restored: string }>('POST', `/decks/${encodeURIComponent(id)}/restore`),
  importDeck: (body: { text: string; formatCode?: DeckFormat; glcType?: string | null; name?: string; source?: 'ptcgl' | 'massentry' }) =>
    send<DeckDetail>('POST', '/decks/import', body),
  previewDeckImport: (body: { text: string; formatCode?: DeckFormat; glcType?: string | null; source?: 'ptcgl' | 'massentry' }) =>
    send<DeckImportPreview>('POST', '/decks/import/preview', body),
  // variantId (migration 051): which printing. Omitted = the card's primary
  // variant on add; on set/remove the server targets the card's single deck
  // row when there is exactly one and 400s when several printings would be
  // ambiguous — so pass it whenever the row is known.
  addDeckCard: (id: string, cardId: string, quantity = 1, variantId?: number) =>
    send<DeckDetail>('POST', `/decks/${encodeURIComponent(id)}/cards`, { cardId, quantity, ...(variantId != null ? { variantId } : {}) }),
  setDeckCardQuantity: (id: string, cardId: string, quantity: number, variantId?: number) =>
    send<DeckDetail>('PATCH', `/decks/${encodeURIComponent(id)}/cards/${encodeURIComponent(cardId)}`, {
      quantity,
      ...(variantId != null ? { variantId } : {}),
    }),
  removeDeckCard: (id: string, cardId: string, variantId?: number) =>
    send<DeckDetail>(
      'DELETE',
      `/decks/${encodeURIComponent(id)}/cards/${encodeURIComponent(cardId)}${variantId != null ? `?variant=${variantId}` : ''}`,
    ),
  validateDeck: (id: string, format?: DeckFormat, signal?: AbortSignal) =>
    get<{ validation: ValidationResult; cardRefs: Record<string, CardRef> }>(
      `/decks/${encodeURIComponent(id)}/validate${format ? `?format=${format}` : ''}`,
      signal,
    ),
  exportDeck: (id: string, format: 'ptcgl' | 'massentry' = 'ptcgl', signal?: AbortSignal) =>
    get<{ format: string; text: string; warnings: { code: string; message: string; cardId: string }[] }>(
      `/decks/${encodeURIComponent(id)}/export?format=${format}`,
      signal,
    ),
  testHand: (id: string, seed?: number, signal?: AbortSignal) =>
    get<TestHand>(`/decks/${encodeURIComponent(id)}/testhand${seed !== undefined ? `?seed=${seed}` : ''}`, signal),
  deckPricing: (id: string, signal?: AbortSignal) => get<DeckPricing>(`/decks/${encodeURIComponent(id)}/pricing`, signal),
  deckMassEntry: (id: string, signal?: AbortSignal) => get<DeckMassEntry>(`/decks/${encodeURIComponent(id)}/massentry`, signal),

  // Deck intelligence — strategy guide, version history, battle logs.
  // Strategy edits never bump the version; null / '' clears the guide.
  setDeckStrategy: (id: string, strategyMd: string | null) =>
    send<DeckDetail>('PUT', `/decks/${encodeURIComponent(id)}/strategy`, { strategyMd }),
  deckVersions: (id: string, signal?: AbortSignal) =>
    get<DeckVersionsResponse>(`/decks/${encodeURIComponent(id)}/versions`, signal),
  deckVersion: (id: string, version: number, signal?: AbortSignal) =>
    get<DeckVersionDetail>(`/decks/${encodeURIComponent(id)}/versions/${version}`, signal),
  // Non-destructive: applies the old snapshot as a NEW version (history is kept).
  revertDeck: (id: string, body: { toVersion: number; includeStrategy?: boolean; note?: string }) =>
    send<DeckDetail & { revert: RevertResult }>('POST', `/decks/${encodeURIComponent(id)}/revert`, body),
  battleLogs: (id: string, params?: { version?: number; page?: number; pageSize?: number }, signal?: AbortSignal) => {
    const q = new URLSearchParams()
    if (params?.version != null) q.set('version', String(params.version))
    if (params?.page != null) q.set('page', String(params.page))
    if (params?.pageSize != null) q.set('pageSize', String(params.pageSize))
    const qs = q.toString()
    return get<BattleLogsResponse>(`/decks/${encodeURIComponent(id)}/logs${qs ? `?${qs}` : ''}`, signal)
  },
  battleLog: (id: string, logId: number, signal?: AbortSignal) =>
    get<{ log: BattleLog }>(`/decks/${encodeURIComponent(id)}/logs/${logId}`, signal),
  addBattleLog: (id: string, body: AddBattleLogBody) =>
    send<{ log: BattleLog; attachedToVersion: number }>('POST', `/decks/${encodeURIComponent(id)}/logs`, body),
  patchBattleLog: (id: string, logId: number, body: { result?: BattleResult | null; opponent?: string | null; opponentDeck?: string | null; notes?: string | null; playedAt?: string }) =>
    send<{ log: BattleLog }>('PATCH', `/decks/${encodeURIComponent(id)}/logs/${logId}`, body),
  deleteBattleLog: (id: string, logId: number) =>
    send<{ deleted: number }>('DELETE', `/decks/${encodeURIComponent(id)}/logs/${logId}`),

  // Signed-in identity — real username, not the JWT's (often-empty) metadata.
  me: (signal?: AbortSignal) => get<MeResponse>('/me', signal),
  familyMe: (signal?: AbortSignal) => get<{ userId: string; family: FamilyContext | null }>('/family/me', signal),
  bootstrapFamily: (name: string) =>
    send<{ family: FamilyContext }>('POST', '/family/bootstrap', { name }),
  familyMembers: (signal?: AbortSignal) =>
    get<{ members: FamilyMemberSummary[] }>('/family/members', signal),
  familyCollection: (userId: string, cursor?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: '100' })
    if (cursor) params.set('cursor', cursor)
    return get<FamilyCollectionPage>(
      `/family/members/${encodeURIComponent(userId)}/collection?${params.toString()}`,
      signal,
    )
  },
  familyInvitations: (signal?: AbortSignal) =>
    get<{ invitations: FamilyInvitation[] }>('/family/invitations', signal),
  // `inviteUrl` is returned once, on creation, and never listed — it is a
  // credential. The admin copies it and sends it to the member themselves; no
  // email is sent by DeckPal or by Supabase.
  inviteFamilyMember: (email: string) =>
    send<{ inviteUrl: string; invitation: FamilyInvitation }>('POST', '/family/invitations', { email }),
  regenerateFamilyInviteLink: (id: string) =>
    send<{ inviteUrl: string }>('POST', `/family/invitations/${encodeURIComponent(id)}/link`),
  revokeFamilyInvitation: (id: string) =>
    send<void>('DELETE', `/family/invitations/${encodeURIComponent(id)}`),
  activateFamilyInvitation: () => send<{ family: FamilyContext }>('POST', '/family/activate'),
  setFamilyMemberStatus: (userId: string, status: 'active' | 'disabled') =>
    send<{ member: { userId: string; status: string } }>(
      'PATCH',
      `/family/members/${encodeURIComponent(userId)}`,
      { status },
    ),
  // Account settings (migration 049) — the server-side home of what used to be
  // device-only preferences. PATCH takes any subset and returns the whole row.
  settings: (signal?: AbortSignal) => get<{ settings: UserSettings }>('/me/settings', signal),
  updateSettings: (patch: Partial<UserSettings>) => send<{ settings: UserSettings }>('PATCH', '/me/settings', patch),
  // Profile showcase — the user_showcase table, replacing the old
  // localStorage-only `deckpal.showcase.v1`. PUT replaces the whole set; the
  // server resolves each card id to its primary variant.
  showcase: (signal?: AbortSignal) => get<{ showcase: ShowcaseSlot[] }>('/me/showcase', signal),
  setShowcase: (cards: (string | null)[]) => send<{ showcase: ShowcaseSlot[] }>('PUT', '/me/showcase', { cards }),

  // Insights / gamification (Phase 6)
  overview: (signal?: AbortSignal) => get<InsightsOverview>('/insights/overview', signal),

  // Personal access tokens (Profile → Agent access). `secret` comes back on
  // create and NOWHERE else — the server stores only a hash of it.
  apiTokens: (signal?: AbortSignal) => get<{ tokens: ApiTokenRow[] }>('/tokens', signal),
  createApiToken: (name: string) => send<{ token: ApiTokenRow; secret: string }>('POST', '/tokens', { name }),
  revokeApiToken: (id: string) => send<{ token: ApiTokenRow }>('DELETE', `/tokens/${encodeURIComponent(id)}`),

  // OAuth "Connect" flow (/authorize consent screen). See apps/api/src/routes/oauth.ts.
  oauthClient: (clientId: string, redirectUri: string) =>
    get<{ clientName: string; redirectUri: string }>(
      `/oauth/client?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    ),
  oauthDecision: (body: {
    decision: 'allow' | 'deny'
    responseType: string
    clientId: string
    redirectUri: string
    codeChallenge: string
    codeChallengeMethod: string
    state?: string
    resource?: string
  }) => send<{ redirectTo: string }>('POST', '/oauth/authorize/decision', body),

  // Profile photo. The server stores a 256×256 WebP re-encoded from whatever
  // was uploaded, so `avatarUrl` changes on every replace (the object key is
  // random) and never needs a cache-busting query string.
  avatar: (signal?: AbortSignal) => get<AvatarState>('/avatar', signal),
  uploadAvatar: (file: Blob) => upload<AvatarState>('/avatar', file),
  removeAvatar: () => send<AvatarState>('DELETE', '/avatar'),

  submitBug: (body: {
    text: string
    page: string
    screenshot?: string
    viewport?: string
    userAgent?: string
    kind?: 'bug' | 'feature'
  }) =>
    send<{ id: string; saved?: string; issueUrl?: string; issueNumber?: number; note?: string }>('POST', '/bugs', body),
  cardPriceHistory: (cardId: string, range: ValueRange, currency = 'USD', signal?: AbortSignal) =>
    get<CardPriceHistoryResponse>(
      `/cards/${encodeURIComponent(cardId)}/prices?range=${range}&currency=${encodeURIComponent(currency)}`,
      signal,
    ),

  cardLegality: (cardId: string, signal?: AbortSignal) =>
    get<CardLegalityResponse>(`/cards/${encodeURIComponent(cardId)}/legality`, signal),

  insightsValue: (range: ValueRange, currency = 'USD', signal?: AbortSignal) =>
    get<ValueResponse>(`/insights/value?range=${range}&currency=${encodeURIComponent(currency)}`, signal),
  dex: (params: URLSearchParams, signal?: AbortSignal) =>
    get<SpeciesGridResponse>(`/insights/pokedex?${params.toString()}`, signal),
  species: (id: string, signal?: AbortSignal) =>
    // `/insights/pokedex/:speciesId` — NOT `/insights/deckpal/…`. The pokedex→
    // deckpal rename swept this string and 404'd every species page ("No such
    // route"); the route is the Pokédex feature, not the product name.
    get<SpeciesDetailResponse>(`/insights/pokedex/${encodeURIComponent(id)}`, signal),
}
