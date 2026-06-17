/**
 * @forge/integrations/router — Semantic Capability Router
 *
 * The router takes a free-form task string and emits:
 *   - `selectedDomains`           — domains with confidence + reason
 *   - `withheldDomains`           — domains we actively did not include
 *   - `selectedGraphRegions`      — graph regions we should hydrate
 *   - `selectedCapabilities`      — capability names to make available
 *
 * The router is intentionally *local* (no LLM call). It is a
 * keyword + manifest-driven scorer with deterministic output, so
 * the harness can re-run it after each evidence update and
 * diff the result.
 *
 * AGENTS.md §6: "The router should optimize for high recall. It is
 * better to include one extra relevant domain than to hide the true
 * source of the bug."
 *
 * Implementation strategy:
 *   1. Tokenise the task string.
 *   2. For every domain, score against the task tokens using the
 *      domain's `riskProfile`, `verification`, capability `tags`,
 *      capability `name`, and the manifest's `owns` globs (which we
 *      also expand to keywords).
 *   3. The top N domains above a floor threshold become
 *      `selectedDomains`; the rest become `withheldDomains` (or
 *      `possibleAdjacentDomains` if the score is in a mid-band).
 *   4. Capabilities from selected domains + co-routed `tests` are
 *      emitted, in score order, deduplicated.
 *   5. Graph regions are derived from the manifests' `graphNodeIds`.
 */
import type { DomainSelection, DomainBelief, GraphRegionBelief } from '@forge/types'
import { DOMAINS, type CapabilityDescriptor, type DomainEntry } from './domains/index.js'

/** Tunable router thresholds. The defaults bias high recall (AGENTS §6). */
export interface RouterConfig {
  /** Domains at or above this score are `selectedDomains`. */
  selectedFloor: number
  /** Domains between `withheldCeiling` (exclusive) and `selectedFloor` are `possibleAdjacentDomains`. */
  withheldCeiling: number
  /** Cap on the number of selected domains (high-recall still includes extras). */
  maxSelectedDomains: number
  /** Cap on selected capabilities emitted to the model. */
  maxSelectedCapabilities: number
  /** Always co-route `tests` with any selected domain (AGENTS-style verification). */
  coRouteTests: boolean
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = Object.freeze({
  selectedFloor: 0.35,
  withheldCeiling: 0.25,
  maxSelectedDomains: 7,
  maxSelectedCapabilities: 12,
  coRouteTests: true,
})

/** Per-domain router output (used for tests / TUI rendering). */
export interface DomainRouteResult {
  domain: string
  confidence: number
  reason: string
  matchedKeywords: string[]
  matchedCapabilities: string[]
}

/** Full router output, including debug-friendly per-domain detail. */
export interface RouterResult extends DomainSelection {
  selectedDomainsDetail: DomainBelief[]
  possibleAdjacentDomainsDetail: DomainBelief[]
  perDomain: DomainRouteResult[]
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'on', 'in', 'is', 'are', 'be', 'with', 'as', 'by',
  'this', 'that', 'it', 'we', 'i', 'you', 'they', 'our', 'your', 'their', 'my', 'me', 'us', 'them',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'have', 'has', 'had', 'having', 'been', 'being', 'am', 'was', 'were',
  'from', 'at', 'into', 'about', 'over', 'under', 'between', 'across', 'after', 'before',
  'but', 'if', 'then', 'else', 'so', 'than', 'too', 'very', 'just', 'also', 'only',
  'fix', 'add', 'update', 'change', 'modify', 'refactor', 'implement', 'make', 'create', 'remove',
  'work', 'working', 'works', 'failed', 'fails', 'failing', 'broken', 'bug', 'issue', 'task',
])

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\/]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
}

function globToKeywords(glob: string): string[] {
  // Strip `**`, `*`, braces, and split on `/` and `.` to recover
  // the meaningful tokens. e.g. `apps/api/src/auth/**` →
  // ['apps', 'api', 'src', 'auth']. `*invite*` → ['invite'].
  return glob
    .replace(/[{}()]/g, ' ')
    .split(/[\/,]/)
    .flatMap((seg) => seg.split('.'))
    .map((seg) => seg.replace(/^\*+|\*+$/g, '').replace(/^_+|_+$/g, ''))
    .filter((s) => s.length >= 3)
}

function buildDomainKeywordSet(entry: DomainEntry): Set<string> {
  const set = new Set<string>()
  for (const seg of entry.manifest.owns) {
    for (const kw of globToKeywords(seg)) set.add(kw)
  }
  for (const seg of entry.manifest.allowedReads) {
    for (const kw of globToKeywords(seg)) set.add(kw)
  }
  for (const risk of entry.manifest.riskProfile) {
    for (const kw of risk.toLowerCase().split(/[\s_-]+/)) {
      if (kw.length >= 3) set.add(kw)
    }
  }
  for (const v of entry.manifest.verification) {
    for (const kw of v.toLowerCase().split(/[\s_-]+/)) {
      if (kw.length >= 3) set.add(kw)
    }
  }
  for (const cap of entry.capabilities) {
    for (const tag of cap.tags) set.add(tag)
    for (const kw of cap.name.toLowerCase().split(/[._\-]+/)) {
      if (kw.length >= 3) set.add(kw)
    }
  }
  return set
}

interface ScoredDomain {
  entry: DomainEntry
  score: number
  matchedKeywords: string[]
  matchedCapabilities: string[]
}

function scoreDomain(taskTokens: string[], entry: DomainEntry, keywords: Set<string>): ScoredDomain {
  const tokenSet = new Set(taskTokens)
  const matched: string[] = []
  let raw = 0
  for (const kw of keywords) {
    if (tokenSet.has(kw)) {
      matched.push(kw)
      raw += 1.0
      continue
    }
    // Substring / partial match: a token `invite` matches keyword `invite-policy`.
    // The substring match is a weak signal — we require a meaningful
    // shared length so e.g. `migrations` (task) vs `migration`
    // (keyword) does not weakly pull every domain that owns a
    // migrations directory into the selected set.
    for (const tok of taskTokens) {
      if (tok.length >= 5 && kw.length >= 5) {
        const shared = sharedPrefixOrSuffix(tok, kw, 5)
        if (shared) {
          matched.push(kw)
          raw += 0.2
          break
        }
      }
    }
  }
  // Capability-name direct hits get a strong bonus (a user mentioning
  // "permission" or "migration" should light up the matching
  // capability).
  const matchedCapabilities: string[] = []
  for (const cap of entry.capabilities) {
    const capTokens = cap.name.toLowerCase().split(/[._\-]+/)
    for (const tok of taskTokens) {
      if (tok.length >= 4 && capTokens.includes(tok)) {
        raw += 0.8
        matchedCapabilities.push(cap.name)
        break
      }
    }
  }
  // Capability-tag direct hits: tags like `permission`, `role`,
  // `migration` should light up the matching capability strongly.
  for (const cap of entry.capabilities) {
    for (const tag of cap.tags) {
      if (tokenSet.has(tag)) {
        raw += 0.5
        break
      }
    }
  }
  // Base presence: every domain gets a tiny floor so the router never
  // returns nothing on a vague task — recall matters.
  if (raw === 0) {
    return { entry, score: 0.02, matchedKeywords: [], matchedCapabilities: [] }
  }
  // Use a square-root-ish curve so 1-2 strong matches still register
  // meaningfully. Cap at 1.0.
  const score = clamp01(Math.min(1, 0.25 + Math.sqrt(raw) * 0.32))
  return { entry, score, matchedKeywords: dedup(matched), matchedCapabilities: dedup(matchedCapabilities) }
}

function sharedPrefixOrSuffix(a: string, b: string, minShared: number): boolean {
  // Return true if `a` and `b` share a prefix or suffix of at least
  // `minShared` characters. Avoids weak matches like `migrations` vs
  // `migration` while still catching e.g. `subscription` vs
  // `subscriptions`.
  let pref = 0
  while (pref < a.length && pref < b.length && a[pref] === b[pref]) pref++
  if (pref >= minShared) return true
  let suff = 0
  while (
    suff < a.length && suff < b.length &&
    a[a.length - 1 - suff] === b[b.length - 1 - suff]
  ) suff++
  return suff >= minShared
}

function dedup(items: string[]): string[] {
  return [...new Set(items)]
}

function domainBelief(result: ScoredDomain, reason: string): DomainBelief {
  return {
    domain: result.entry.manifest.domain,
    confidence: round4(clamp01(result.score)),
    reason,
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** The router. Stateless. */
export class CapabilityRouter {
  private readonly config: RouterConfig

  constructor(config: Partial<RouterConfig> = {}) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config }
  }

  /**
   * Route a task string to a `RouterResult`.
   * @param task free-form task description
   * @param options optional overrides for this call only
   */
  route(task: string, options: Partial<RouterConfig> = {}): RouterResult {
    const config: RouterConfig = { ...this.config, ...options }
    const tokens = tokenise(task)

    const scored: ScoredDomain[] = DOMAINS.all.map((entry) => {
      const kw = buildDomainKeywordSet(entry)
      return scoreDomain(tokens, entry, kw)
    })

    scored.sort((a, b) => b.score - a.score)

    const selected: ScoredDomain[] = []
    const adjacent: ScoredDomain[] = []
    const withheld: ScoredDomain[] = []

    for (const s of scored) {
      if (s.score >= config.selectedFloor && selected.length < config.maxSelectedDomains) {
        selected.push(s)
      } else if (s.score >= config.withheldCeiling) {
        adjacent.push(s)
      } else {
        withheld.push(s)
      }
    }

    // Always include `tests` (or `repo` if tests is the only one above
    // the floor and tests isn't) when at least one domain is
    // selected. The `coRouteTests` knob lets callers turn this off
    // for very narrow task classes (e.g. pure research).
    if (config.coRouteTests && selected.length > 0 && !selected.some((s) => s.entry.manifest.domain === 'tests')) {
      const testsEntry = DOMAINS.byName['tests']
      if (testsEntry && selected.length < config.maxSelectedDomains) {
        selected.push({ entry: testsEntry, score: 0.4, matchedKeywords: ['co-routed'], matchedCapabilities: [] })
      }
    }

    const selectedDomainsDetail: DomainBelief[] = selected.map((s) =>
      domainBelief(s, reasonFor(s, 'selected')),
    )
    const possibleAdjacentDomainsDetail: DomainBelief[] = adjacent.map((s) =>
      domainBelief(s, reasonFor(s, 'adjacent')),
    )

    // Graph regions: union of selected domains' `graphNodeIds`. We also
    // pull in `graphEdgeIds` so the TUI can render edges.
    const selectedGraphRegions: GraphRegionBelief[] = []
    const seenRegion = new Set<string>()
    for (const s of selected) {
      for (const id of s.entry.manifest.graphNodeIds ?? []) {
        if (!seenRegion.has(id)) {
          seenRegion.add(id)
          selectedGraphRegions.push({ regionId: id, confidence: round4(clamp01(s.score)), reason: s.entry.manifest.domain })
        }
      }
    }

    // Capabilities: pull from selected domains, dedup, sort by gain
    // then by domain-priority.
    const capMap = new Map<string, { cap: CapabilityDescriptor; score: number }>()
    for (const s of selected) {
      for (const cap of s.entry.capabilities) {
        const existing = capMap.get(cap.name)
        const capScore = capabilityScore(cap) + s.score
        if (!existing || existing.score < capScore) {
          capMap.set(cap.name, { cap, score: capScore })
        }
      }
    }
    const sortedCaps = [...capMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, config.maxSelectedCapabilities)
    const selectedCapabilities = sortedCaps.map((c) => c.cap.name)

    // Withheld domains = everything not selected / not adjacent.
    const withheldNames = withheld
      .map((w) => w.entry.manifest.domain)
      .filter((name) => !selected.some((s) => s.entry.manifest.domain === name))
      .filter((name) => !adjacent.some((a) => a.entry.manifest.domain === name))

    const perDomain: DomainRouteResult[] = scored.map((s) => ({
      domain: s.entry.manifest.domain,
      confidence: round4(clamp01(s.score)),
      reason: reasonFor(s, s.score >= config.selectedFloor ? 'selected' : s.score >= config.withheldCeiling ? 'adjacent' : 'withheld'),
      matchedKeywords: s.matchedKeywords,
      matchedCapabilities: s.matchedCapabilities,
    }))

    return {
      selectedDomains: selectedDomainsDetail.map((d) => d.domain),
      possibleAdjacentDomains: possibleAdjacentDomainsDetail.map((d) => d.domain),
      withheldDomains: withheldNames,
      selectedGraphRegions: selectedGraphRegions.map((r) => r.regionId),
      selectedCapabilities,
      selectedDomainsDetail,
      possibleAdjacentDomainsDetail,
      perDomain,
    }
  }
}

function reasonFor(s: ScoredDomain, kind: 'selected' | 'adjacent' | 'withheld'): string {
  if (kind === 'withheld') {
    return `withheld: no significant keyword overlap (${s.matchedKeywords.slice(0, 3).join(', ') || 'none'})`
  }
  const hits = s.matchedKeywords.slice(0, 4).join(', ')
  return `${kind}: matched ${hits || s.entry.manifest.domain + ' domain tokens'}`
}

function capabilityScore(cap: CapabilityDescriptor): number {
  const gainWeight = { low: 0.1, medium: 0.3, high: 0.6 }[cap.gain]
  const riskPenalty = { low: 0, medium: 0.05, high: 0.15, critical: 0.3 }[cap.risk]
  return gainWeight - riskPenalty
}
