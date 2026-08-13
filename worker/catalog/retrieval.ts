/**
 * Bounded catalogue retrieval.
 *
 * Two things happen here, in this order, and the order is the point:
 *
 * 1. Deterministic evidence. An article number the request printed, or wording
 *    the catalogue already records as a name for a product — globally or for
 *    this one customer — settles a line without any generative judgement.
 * 2. Full-text retrieval. Everything else is looked up against an FTS5 index
 *    over the *complete* active catalogue, and only a small shortlist of that
 *    result is ever allowed to reach a model.
 *
 * Archived products are never returned as candidates. When a request names one
 * — a superseded article number, a legacy item number — its live successor is
 * offered instead and the line is marked as needing confirmation, because
 * silently substituting a different product is a business decision, not a
 * lookup.
 *
 * The index is built from the seeded catalogue on first use and rebuilt
 * whenever the catalogue's signature changes, so seeding again (which only ever
 * inserts) cannot leave stale retrieval behind. Replacing this module with
 * embeddings later would not change the orchestration around it.
 */

export const SHORTLIST_SIZE = 8

export type CandidateSource =
  | "exact_sku"
  | "known_alias"
  | "customer_alias"
  | "typo_alias"
  | "legacy_alias"
  | "archived_successor"
  | "full_text"

export type CatalogProduct = {
  sku: string
  name: string
  description: string
  category: string
  manufacturer: string
  unit: string
  status: string
  replacementSku: string | null
  nearDuplicateOf: string | null
}

export type Candidate = CatalogProduct & {
  source: CandidateSource
  score: number
  /** Why this product is in front of a reviewer at all. */
  evidence: string
}

/** What retrieval decided about one requested line. */
export type LineRetrieval =
  | {
      /** Deterministic evidence settles it; no model is asked. */
      state: "exact"
      candidate: Candidate
      shortlist: Candidate[]
      query: string
    }
  | {
      /** A superseded product was named; its successor needs confirmation. */
      state: "superseded"
      supersededSku: string
      candidate: Candidate | null
      shortlist: Candidate[]
      query: string
    }
  | {
      /** Nothing deterministic; the shortlist goes to the reranker. */
      state: "retrieved"
      shortlist: Candidate[]
      query: string
    }

type AliasMatch = {
  sku: string
  alias: string
  kind: string
  /** True when the request states the alias and nothing else. */
  exact: boolean
}

export type RetrievalQuery = {
  reference: string
  description: string
  /** Only ever a SKU that survived extraction's business validation. */
  catalogSku: string | null
}

const PRODUCT_COLUMNS = `sku, name, description, category, manufacturer, unit,
       status, replacement_sku, near_duplicate_of`

type ProductRow = {
  sku: string
  name: string
  description: string
  category: string
  manufacturer: string
  unit: string
  status: string
  replacement_sku: string | null
  near_duplicate_of: string | null
}

/* -------------------------------------------------------------------------- */
/* The full-text index                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Makes sure the indexes reflect the catalogue, rebuilding them when they do
 * not. The signature is deliberately cheap: seeding only inserts, so a changed
 * row count is the only way the catalogue can differ from what was indexed.
 */
export async function ensureCatalogIndexes(env: Env): Promise<void> {
  const signature = await catalogSignature(env)

  const state = await env.DB.prepare(
    `SELECT signature FROM catalog_search_state WHERE id = 1`
  ).first<{ signature: string }>()

  if (state?.signature === signature.value) return

  const aliases = await env.DB.prepare(
    `SELECT sku, alias, alias_kind, customer_id FROM catalog_product_aliases
      ORDER BY sku ASC, alias ASC`
  ).all<{
    sku: string
    alias: string
    alias_kind: string
    customer_id: string | null
  }>()

  const rows = await env.DB.prepare(
    `SELECT p.sku AS sku, p.name AS name, p.description AS description,
            p.category AS category, p.manufacturer AS manufacturer,
            p.unit AS unit,
            COALESCE(
              (SELECT group_concat(a.alias, ' ') FROM catalog_product_aliases a
                WHERE a.sku = p.sku), ''
            ) AS aliases
       FROM catalog_products p
      WHERE p.status = 'active'
      ORDER BY p.sku ASC`
  ).all<{
    sku: string
    name: string
    description: string
    category: string
    manufacturer: string
    unit: string
    aliases: string
  }>()

  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM catalog_search`),
    env.DB.prepare(`DELETE FROM catalog_alias_lookup`),
  ]

  for (const alias of aliases.results) {
    const normalised = normaliseText(alias.alias)
    if (normalised.length === 0) continue

    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO catalog_alias_lookup
           (normalised, sku, alias, alias_kind, customer_id)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        normalised,
        alias.sku,
        alias.alias,
        alias.alias_kind,
        alias.customer_id
      )
    )
  }

  for (const row of rows.results) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO catalog_search (sku, text) VALUES (?, ?)`
      ).bind(
        row.sku,
        normaliseText(
          [
            row.sku,
            row.name,
            row.description,
            row.category,
            row.manufacturer,
            row.unit,
            row.aliases,
          ].join(" ")
        )
      )
    )
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO catalog_search_state (id, signature, indexed_products, built_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         signature = excluded.signature,
         indexed_products = excluded.indexed_products,
         built_at = excluded.built_at`
    ).bind(signature.value, rows.results.length, now)
  )

  for (let index = 0; index < statements.length; index += 200) {
    await env.DB.batch(statements.slice(index, index + 200))
  }

  console.log(
    JSON.stringify({
      event: "catalog_indexes_built",
      products: rows.results.length,
      signature: signature.value,
    })
  )
}

async function catalogSignature(env: Env): Promise<{ value: string }> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM catalog_products WHERE status = 'active') AS active,
       (SELECT COUNT(*) FROM catalog_products) AS total,
       (SELECT COUNT(*) FROM catalog_product_aliases) AS aliases`
  ).first<{ active: number; total: number; aliases: number }>()

  return {
    value: `${row?.active ?? 0}:${row?.total ?? 0}:${row?.aliases ?? 0}`,
  }
}

/* -------------------------------------------------------------------------- */
/* Retrieving one line                                                        */
/* -------------------------------------------------------------------------- */

export async function retrieveForLine(
  env: Env,
  query: RetrievalQuery,
  customerId: string | null
): Promise<LineRetrieval> {
  const searchText = [query.reference, query.description]
    .filter((part) => part && part.trim().length > 0)
    .join(" ")

  // 1. An article number the request printed. Only an active product settles a
  //    line; an archived one is a superseded reference, not an answer.
  const printed = query.catalogSku?.trim().toUpperCase() ?? null

  if (printed) {
    const product = await loadProduct(env, printed)

    if (product?.status === "active") {
      return {
        state: "exact",
        candidate: {
          ...product,
          source: "exact_sku",
          score: 1,
          evidence: `The request prints the current article number ${product.sku}.`,
        },
        shortlist: [],
        query: searchText,
      }
    }

    if (product) {
      return await supersededResult(env, product, searchText)
    }
  }

  // 2. Wording the catalogue already records for a product. Customer-specific
  //    wording only counts when this run resolved to that customer; an
  //    unresolved run simply never sees it.
  const alias = await findAlias(
    env,
    [query.reference, query.description],
    customerId
  )

  if (alias) {
    const product = await loadProduct(env, alias.sku)

    if (product && product.status === "archived") {
      return await supersededResult(env, product, searchText)
    }

    if (product) {
      // Only wording the request states *exactly*, and only a catalogue or
      // customer name for the product, settles a line on its own. A recorded
      // misspelling, a superseded number, or wording merely quoted inside a
      // longer phrase is retrieval evidence: it leads the shortlist, and the
      // model still has to defend it.
      const deterministic =
        alias.exact && (alias.kind === "alias" || alias.kind === "customer")

      if (deterministic) {
        return {
          state: "exact",
          candidate: {
            ...product,
            source:
              alias.kind === "customer" ? "customer_alias" : "known_alias",
            score: 1,
            evidence:
              alias.kind === "customer"
                ? `“${alias.alias}” is wording this customer is recorded as using for ${product.sku}.`
                : `“${alias.alias}” is a known catalogue name for ${product.sku}.`,
          },
          shortlist: [],
          query: searchText,
        }
      }

      const shortlist = await shortlistFor(env, searchText, {
        ...product,
        source: alias.kind === "legacy" ? "legacy_alias" : "typo_alias",
        score: 1,
        evidence:
          alias.kind === "typo"
            ? `“${alias.alias}” is a recorded misspelling of ${product.sku}.`
            : alias.kind === "legacy"
              ? `“${alias.alias}” is a superseded number for ${product.sku}, which is still stocked.`
              : `The request quotes “${alias.alias}”, a known catalogue name for ${product.sku}, inside a longer phrase.`,
      })

      return { state: "retrieved", shortlist, query: searchText }
    }
  }

  return {
    state: "retrieved",
    shortlist: await shortlistFor(env, searchText, null),
    query: searchText,
  }
}

/**
 * A request that names a product the catalogue has retired. The successor is
 * offered as the leading candidate, never accepted automatically.
 */
async function supersededResult(
  env: Env,
  archived: CatalogProduct,
  searchText: string
): Promise<LineRetrieval> {
  const successor = archived.replacementSku
    ? await loadProduct(env, archived.replacementSku)
    : null

  const leading =
    successor && successor.status === "active"
      ? {
          ...successor,
          source: "archived_successor" as const,
          score: 1,
          evidence: `${archived.sku} is archived; the catalogue records ${successor.sku} as its replacement.`,
        }
      : null

  return {
    state: "superseded",
    supersededSku: archived.sku,
    candidate: leading,
    shortlist: await shortlistFor(env, searchText, leading),
    query: searchText,
  }
}

/**
 * The bounded shortlist: full-text retrieval across the complete active
 * catalogue, cut to eight. A leading candidate found by other evidence keeps
 * first place and does not cost the shortlist a slot for a duplicate.
 */
async function shortlistFor(
  env: Env,
  searchText: string,
  leading: Candidate | null
): Promise<Candidate[]> {
  const retrieved = await searchCatalog(
    env,
    searchText,
    leading ? SHORTLIST_SIZE - 1 : SHORTLIST_SIZE
  )

  const shortlist = leading ? [leading] : []

  for (const candidate of retrieved) {
    if (shortlist.some((entry) => entry.sku === candidate.sku)) continue
    if (shortlist.length >= SHORTLIST_SIZE) break
    shortlist.push(candidate)
  }

  return shortlist
}

/**
 * Full-text retrieval over the complete active catalogue. Ranking is BM25,
 * reported as a positive relevance number so the evidence reads naturally.
 */
export async function searchCatalog(
  env: Env,
  searchText: string,
  limit: number
): Promise<Candidate[]> {
  const expression = matchExpression(searchText)
  if (!expression || limit <= 0) return []

  await ensureCatalogIndexes(env)

  const rows = await env.DB.prepare(
    `SELECT p.sku AS sku, p.name AS name, p.description AS description,
            p.category AS category, p.manufacturer AS manufacturer,
            p.unit AS unit, p.status AS status,
            p.replacement_sku AS replacement_sku,
            p.near_duplicate_of AS near_duplicate_of,
            bm25(catalog_search) AS score
       FROM catalog_search
       JOIN catalog_products p ON p.sku = catalog_search.sku
      WHERE catalog_search MATCH ?
        AND p.status = 'active'
      ORDER BY score ASC, p.sku ASC
      LIMIT ?`
  )
    .bind(expression, limit)
    .all<ProductRow & { score: number }>()

  return rows.results.map((row, index) => ({
    ...toProduct(row),
    source: "full_text" as const,
    score: Math.round(-row.score * 1000) / 1000,
    evidence: `Full-text retrieval ranked this ${ordinal(index + 1)} across the active catalogue.`,
  }))
}

/**
 * An FTS5 MATCH expression built from the request's own words. Every token is
 * quoted, so nothing a request contains can be read as query syntax.
 */
export function matchExpression(searchText: string): string | null {
  const tokens = [...new Set(tokenise(searchText))].slice(0, 24)
  if (tokens.length === 0) return null

  return tokens.map((token) => `"${token}"`).join(" OR ")
}

/**
 * The same normalisation is applied to indexed text and to a query, so a
 * dimension written `592x592` in one place and `592 x 592` in the other still
 * meets in the middle.
 */
export function normaliseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function tokenise(value: string): string[] {
  return normaliseText(value)
    .split(" ")
    .filter((token) => token.length > 0)
}

/* -------------------------------------------------------------------------- */
/* Exact lookups                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Wording the catalogue already records for a product.
 *
 * A phrase the request states *exactly* is the strong case. A phrase quoted
 * inside a longer sentence — "old item nr 45-221-B (pump seal)" — is the common
 * one, so every contiguous run of words in the request is looked up too, and
 * the longest match wins. Only the exact case is ever allowed to settle a line
 * without a model; the rest is retrieval evidence.
 */
async function findAlias(
  env: Env,
  phrases: string[],
  customerId: string | null
): Promise<AliasMatch | null> {
  const exactPhrases = new Set(
    phrases
      .map((phrase) => normaliseText(phrase ?? ""))
      .filter((phrase) => phrase.length > 0)
  )

  const wanted = [...new Set([...exactPhrases, ...quotedPhrases(phrases)])]
  if (wanted.length === 0) return null

  await ensureCatalogIndexes(env)

  const placeholders = wanted.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT a.normalised AS normalised, a.sku AS sku, a.alias AS alias,
            a.alias_kind AS kind, p.status AS status
       FROM catalog_alias_lookup a
       JOIN catalog_products p ON p.sku = a.sku
      WHERE a.normalised IN (${placeholders})
        AND (a.customer_id IS NULL OR a.customer_id = ?)`
  )
    .bind(...wanted, customerId)
    .all<{
      normalised: string
      sku: string
      alias: string
      kind: string
      status: string
    }>()

  if (rows.results.length === 0) return null

  const matches = rows.results.map((row) => ({
    sku: row.sku,
    alias: row.alias,
    kind: row.kind,
    status: row.status,
    exact: exactPhrases.has(row.normalised),
    words: row.normalised.split(" ").length,
  }))

  // An exact statement beats a quotation; a longer quotation beats a shorter
  // one; then customer wording, a catalogue name, a misspelling, a superseded
  // number. An archived product still wins its own superseded number, which is
  // what makes the substitution visible instead of silent.
  const rank = (kind: string) =>
    kind === "customer" ? 0 : kind === "alias" ? 1 : kind === "typo" ? 2 : 3

  matches.sort(
    (left, right) =>
      Number(right.exact) - Number(left.exact) ||
      right.words - left.words ||
      rank(left.kind) - rank(right.kind) ||
      left.sku.localeCompare(right.sku)
  )

  return {
    sku: matches[0].sku,
    alias: matches[0].alias,
    kind: matches[0].kind,
    exact: matches[0].exact,
  }
}

/** Every contiguous run of two to six words the request wrote. */
function quotedPhrases(phrases: string[]): string[] {
  const found: string[] = []

  for (const phrase of phrases) {
    const tokens = tokenise(phrase ?? "")

    for (let start = 0; start < tokens.length; start++) {
      for (let length = 2; length <= 6; length++) {
        if (start + length > tokens.length) break
        found.push(tokens.slice(start, start + length).join(" "))
      }
    }
  }

  return [...new Set(found)].slice(0, 80)
}

/**
 * The global catalogue names of a product: the wording a reranker is allowed to
 * see beside the product's own description. Wording private to one customer is
 * deliberately excluded, because it is that customer's vocabulary and it has
 * already been used deterministically where it applies.
 */
export async function loadGlobalAliases(
  env: Env,
  skus: string[]
): Promise<Map<string, string[]>> {
  if (skus.length === 0) return new Map()

  const placeholders = skus.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT sku, alias FROM catalog_product_aliases
      WHERE sku IN (${placeholders}) AND customer_id IS NULL
      ORDER BY sku ASC, alias ASC`
  )
    .bind(...skus)
    .all<{ sku: string; alias: string }>()

  const aliases = new Map<string, string[]>()

  for (const row of rows.results) {
    const existing = aliases.get(row.sku)
    if (existing) existing.push(row.alias)
    else aliases.set(row.sku, [row.alias])
  }

  return aliases
}

export async function loadProduct(
  env: Env,
  sku: string
): Promise<CatalogProduct | null> {
  const row = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM catalog_products WHERE sku = ?`
  )
    .bind(sku)
    .first<ProductRow>()

  return row ? toProduct(row) : null
}

/** Only active products exist as far as a match is concerned. */
export async function loadActiveProducts(
  env: Env,
  skus: string[]
): Promise<Map<string, CatalogProduct>> {
  if (skus.length === 0) return new Map()

  const placeholders = skus.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM catalog_products
      WHERE sku IN (${placeholders}) AND status = 'active'`
  )
    .bind(...skus)
    .all<ProductRow>()

  return new Map(rows.results.map((row) => [row.sku, toProduct(row)]))
}

function toProduct(row: ProductRow): CatalogProduct {
  return {
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    manufacturer: row.manufacturer,
    unit: row.unit,
    status: row.status,
    replacementSku: row.replacement_sku,
    nearDuplicateOf: row.near_duplicate_of,
  }
}

function ordinal(position: number): string {
  const names = [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
  ]

  return names[position - 1] ?? `number ${position}`
}
