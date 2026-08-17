import { useState, type ReactNode } from "react"
import { ArrowLeftIcon, MagnifyingGlassIcon } from "@phosphor-icons/react"
import { createFileRoute, Link, notFound } from "@tanstack/react-router"

import {
  CATALOGUE_SECTIONS,
  fetchCatalogue,
  isCatalogueSection,
  type CatalogueAlias,
  type CatalogueCustomer,
  type CatalogueOrder,
  type CatalogueProduct,
  type CatalogueProjection,
  type CatalogueSection,
} from "@/lib/api"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/catalogue/$section")({
  loader: ({ params }) => {
    if (!isCatalogueSection(params.section)) {
      notFound({ throw: true })
      throw new Error("Unreachable after notFound")
    }
    return fetchCatalogue(params.section)
  },
  component: CataloguePage,
  pendingComponent: CataloguePending,
  errorComponent: CatalogueError,
})

const SECTION_COPY: Record<
  CatalogueSection,
  { title: string; shortTitle: string; description: string; searchHint: string }
> = {
  products: {
    title: "Products",
    shortTitle: "Products",
    description:
      "Every active and archived article in the deterministic synthetic catalogue, including pricing and replacement relationships.",
    searchHint: "Search SKU, product, category, or manufacturer",
  },
  customers: {
    title: "Customers",
    shortTitle: "Customers",
    description:
      "All synthetic customer accounts with their pricing tiers and summarized contacts and delivery locations.",
    searchHint: "Search account, domain, contact, or city",
  },
  orders: {
    title: "Historical orders",
    shortTitle: "Orders",
    description:
      "The synthetic order history used to exercise customer-specific retrieval and pricing decisions.",
    searchHint: "Search order, customer, contact, city, or SKU",
  },
  aliases: {
    title: "Aliases and variants",
    shortTitle: "Aliases",
    description:
      "Seeded shorthand, misspellings, superseded references, and customer-specific wording used during deterministic lookup.",
    searchHint: "Search alias, kind, SKU, product, or customer",
  },
}

function CataloguePage() {
  const catalogue = Route.useLoaderData()
  const copy = SECTION_COPY[catalogue.section]

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden />
        Back to requests
      </Link>

      <div className="mt-6 max-w-3xl">
        <p className="text-[13px] font-medium text-muted-foreground">
          Synthetic catalogue
        </p>
        <h1 className="mt-1.5 text-xl leading-7 font-medium tracking-[-0.02em]">
          {copy.title}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {copy.description}
        </p>
      </div>

      <CatalogueNavigation current={catalogue.section} />
      <CatalogueTable key={catalogue.section} catalogue={catalogue} />
    </main>
  )
}

function CatalogueNavigation({ current }: { current: CatalogueSection }) {
  return (
    <nav className="mt-6" aria-label="Catalogue sections">
      <ul className="flex flex-wrap gap-1.5">
        {CATALOGUE_SECTIONS.map((section) => (
          <li key={section}>
            <Link
              to="/catalogue/$section"
              params={{ section }}
              aria-current={section === current ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center rounded-md border bg-background px-3 text-[13px] font-medium transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30",
                section === current &&
                  "border-foreground bg-foreground text-background"
              )}
            >
              {SECTION_COPY[section].shortTitle}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function CatalogueTable({ catalogue }: { catalogue: CatalogueProjection }) {
  switch (catalogue.section) {
    case "products":
      return (
        <SearchableTable
          rows={catalogue.rows}
          noun="products"
          searchHint={SECTION_COPY.products.searchHint}
          minWidth="min-w-[1040px]"
          columns={[
            "SKU",
            "Product",
            "Category",
            "Manufacturer",
            "Unit",
            "Base price",
            "Status",
          ]}
          rowKey={(row) => row.sku}
          searchText={productSearchText}
          renderRow={(row) => <ProductRow row={row} />}
        />
      )
    case "customers":
      return (
        <SearchableTable
          rows={catalogue.rows}
          noun="customers"
          searchHint={SECTION_COPY.customers.searchHint}
          minWidth="min-w-[980px]"
          columns={["Account", "Domain", "Tier", "Contacts", "Locations"]}
          rowKey={(row) => row.id}
          searchText={customerSearchText}
          renderRow={(row) => <CustomerRow row={row} />}
        />
      )
    case "orders":
      return (
        <SearchableTable
          rows={catalogue.rows}
          noun="orders"
          searchHint={SECTION_COPY.orders.searchHint}
          minWidth="min-w-[1060px]"
          columns={[
            "Order",
            "Date",
            "Customer",
            "Contact / location",
            "Items",
            "Volume",
            "Total",
          ]}
          rowKey={(row) => row.id}
          searchText={orderSearchText}
          renderRow={(row) => <OrderRow row={row} />}
        />
      )
    case "aliases":
      return (
        <SearchableTable
          rows={catalogue.rows}
          noun="aliases"
          searchHint={SECTION_COPY.aliases.searchHint}
          minWidth="min-w-[860px]"
          columns={["Alias", "Kind", "SKU", "Product", "Scope"]}
          rowKey={(row) =>
            `${row.sku}:${row.kind}:${row.alias}:${row.customerId ?? "global"}`
          }
          searchText={aliasSearchText}
          renderRow={(row) => <AliasRow row={row} />}
        />
      )
  }
}

function SearchableTable<T>({
  rows,
  noun,
  searchHint,
  minWidth,
  columns,
  rowKey,
  searchText,
  renderRow,
}: {
  rows: T[]
  noun: string
  searchHint: string
  minWidth: string
  columns: string[]
  rowKey: (row: T) => string
  searchText: (row: T) => string
  renderRow: (row: T) => ReactNode
}) {
  const [query, setQuery] = useState("")
  const normalized = query.trim().toLocaleLowerCase()
  const visibleRows = normalized
    ? rows.filter((row) =>
        searchText(row).toLocaleLowerCase().includes(normalized)
      )
    : rows

  return (
    <section className="mt-6" aria-labelledby="catalogue-table-heading">
      <h2 id="catalogue-table-heading" className="sr-only">
        Searchable {noun} table
      </h2>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="block w-full max-w-lg">
          <span className="text-[13px] font-medium">Search</span>
          <span className="relative mt-1.5 block">
            <MagnifyingGlassIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchHint}
              className="h-10 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </span>
        </label>
        <p
          className="shrink-0 text-[13px] text-muted-foreground"
          aria-live="polite"
        >
          Showing {visibleRows.length} of {rows.length} {noun}
        </p>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border bg-card shadow-xs">
        <div className="overflow-x-auto">
          <table className={cn("w-full border-collapse text-left", minWidth)}>
            <caption className="sr-only">
              {noun} in the synthetic catalogue
            </caption>
            <thead className="border-b bg-muted/40">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="h-10 px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleRows.map((row) => (
                <CatalogueRowBoundary key={rowKey(row)}>
                  {renderRow(row)}
                </CatalogueRowBoundary>
              ))}
              {visibleRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-4 py-10 text-center text-sm text-muted-foreground"
                  >
                    No {noun} match “{query.trim()}”.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

/** Keeps the generic table responsible for keys without adding DOM wrappers. */
function CatalogueRowBoundary({ children }: { children: ReactNode }) {
  return children
}

function ProductRow({ row }: { row: CatalogueProduct }) {
  return (
    <tr className="align-top transition-colors hover:bg-muted/25">
      <td className="px-4 py-3 font-mono text-[12px] whitespace-nowrap">
        {row.sku}
      </td>
      <td className="min-w-72 px-4 py-3">
        <p className="text-[13px] font-medium">{row.name}</p>
        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
          {row.description}
        </p>
        {row.replacementSku || row.nearDuplicateOf ? (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {row.replacementSku
              ? `Replaced by ${row.replacementSku}`
              : `Near duplicate of ${row.nearDuplicateOf}`}
          </p>
        ) : null}
      </td>
      <td className="px-4 py-3 text-[13px]">{row.category}</td>
      <td className="px-4 py-3 text-[13px]">{row.manufacturer}</td>
      <td className="px-4 py-3 text-[13px] whitespace-nowrap">{row.unit}</td>
      <td className="px-4 py-3 text-[13px] whitespace-nowrap tabular-nums">
        {formatCurrency(row.basePriceCents)}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={row.status} />
      </td>
    </tr>
  )
}

function CustomerRow({ row }: { row: CatalogueCustomer }) {
  return (
    <tr className="align-top transition-colors hover:bg-muted/25">
      <td className="min-w-56 px-4 py-3">
        <p className="text-[13px] font-medium">{row.name}</p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {row.id}
        </p>
      </td>
      <td className="px-4 py-3 font-mono text-[12px]">{row.domain}</td>
      <td className="px-4 py-3 text-[13px] whitespace-nowrap">
        <span className="font-medium">{sentenceCase(row.tier)}</span>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {formatPercent(row.tierDiscountBp)} discount
        </span>
      </td>
      <td className="min-w-60 px-4 py-3 text-[13px]">
        <span className="font-medium">{row.contactCount}</span>
        <span className="mt-1 block text-[12px] leading-5 text-muted-foreground">
          {row.contactNames.join(" · ")}
        </span>
      </td>
      <td className="min-w-52 px-4 py-3 text-[13px]">
        <span className="font-medium">{row.locationCount}</span>
        <span className="mt-1 block text-[12px] leading-5 text-muted-foreground">
          {row.cities.join(" · ")}
        </span>
      </td>
    </tr>
  )
}

function OrderRow({ row }: { row: CatalogueOrder }) {
  return (
    <tr className="align-top transition-colors hover:bg-muted/25">
      <td className="px-4 py-3 font-mono text-[12px] whitespace-nowrap">
        {row.id}
      </td>
      <td className="px-4 py-3 text-[13px] whitespace-nowrap">
        {formatDate(row.orderedAt)}
      </td>
      <td className="min-w-52 px-4 py-3">
        <p className="text-[13px] font-medium">{row.customerName}</p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {row.customerId}
        </p>
      </td>
      <td className="min-w-48 px-4 py-3 text-[13px]">
        {row.contactName}
        <span className="mt-1 block text-[12px] text-muted-foreground">
          {row.city}
        </span>
      </td>
      <td className="min-w-64 px-4 py-3 font-mono text-[11px] leading-5 text-muted-foreground">
        {row.skus.join(" · ")}
      </td>
      <td className="px-4 py-3 text-[13px] whitespace-nowrap tabular-nums">
        {row.lineCount} lines
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {row.totalQuantity} units
        </span>
      </td>
      <td className="px-4 py-3 text-[13px] font-medium whitespace-nowrap tabular-nums">
        {formatCurrency(row.totalCents)}
      </td>
    </tr>
  )
}

function AliasRow({ row }: { row: CatalogueAlias }) {
  return (
    <tr className="align-top transition-colors hover:bg-muted/25">
      <td className="min-w-64 px-4 py-3 text-[13px] font-medium">
        {row.alias}
      </td>
      <td className="px-4 py-3 text-[12px] whitespace-nowrap text-muted-foreground">
        {sentenceCase(row.kind)}
      </td>
      <td className="px-4 py-3 font-mono text-[12px] whitespace-nowrap">
        {row.sku}
      </td>
      <td className="min-w-56 px-4 py-3 text-[13px]">{row.productName}</td>
      <td className="min-w-48 px-4 py-3 text-[13px]">
        {row.customerName ?? "Global"}
        {row.customerId ? (
          <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
            {row.customerId}
          </span>
        ) : null}
      </td>
    </tr>
  )
}

function StatusBadge({ status }: { status: string }) {
  const active = status === "active"

  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md border px-2 text-[11px] font-medium",
        active
          ? "border-workflow-complete/30 bg-workflow-complete-soft text-workflow-complete"
          : "bg-muted/50 text-muted-foreground"
      )}
    >
      {sentenceCase(status)}
    </span>
  )
}

function productSearchText(row: CatalogueProduct): string {
  return [
    row.sku,
    row.name,
    row.description,
    row.category,
    row.manufacturer,
    row.unit,
    row.status,
    row.replacementSku,
    row.nearDuplicateOf,
  ]
    .filter(Boolean)
    .join(" ")
}

function customerSearchText(row: CatalogueCustomer): string {
  return [
    row.id,
    row.name,
    row.domain,
    row.tier,
    ...row.contactNames,
    ...row.cities,
  ].join(" ")
}

function orderSearchText(row: CatalogueOrder): string {
  return [
    row.id,
    row.orderedAt,
    row.customerId,
    row.customerName,
    row.contactName,
    row.city,
    ...row.skus,
  ].join(" ")
}

function aliasSearchText(row: CatalogueAlias): string {
  return [
    row.alias,
    row.kind,
    row.sku,
    row.productName,
    row.customerId,
    row.customerName,
  ]
    .filter(Boolean)
    .join(" ")
}

function sentenceCase(value: string): string {
  const text = value.replaceAll("_", " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100)
}

function formatPercent(basisPoints: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(basisPoints / 10_000)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(
    new Date(value)
  )
}

function CataloguePending() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <p className="text-sm text-muted-foreground">Loading catalogue…</p>
    </main>
  )
}

function CatalogueError({ error }: { error: Error }) {
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-12 sm:px-6">
      <div className="rounded-lg border bg-card p-5 shadow-xs">
        <h1 className="text-base font-medium">Catalogue unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {error.message || "The catalogue could not be read."}
        </p>
        <Link
          to="/"
          className="mt-4 inline-flex text-[13px] font-medium underline underline-offset-4"
        >
          Back to requests
        </Link>
      </div>
    </main>
  )
}
