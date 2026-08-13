/**
 * Deterministic synthetic distributor dataset.
 *
 * Everything a demo run needs to look like a real industrial and facilities
 * wholesaler — products, aliases, customers, contacts, locations, order
 * history, and pricing exceptions — is derived from one integer seed. The same
 * seed always produces byte-identical output, so the committed seed SQL, the
 * curated scenarios, and the gold evaluation fixtures stay in agreement.
 *
 * This module is intentionally self-contained (no imports): the seed build
 * script loads it directly through Node type stripping, which cannot resolve
 * extensionless relative specifiers.
 *
 * All names, addresses, contacts, and part numbers here are invented.
 */

export const CATALOG_SEED = 20260813

export type ProductStatus = "active" | "archived"

export type AliasKind = "alias" | "typo" | "legacy" | "customer"

export type ProductAlias = {
  alias: string
  kind: AliasKind
  /** Set only for aliases a single customer uses in their own requests. */
  customerId: string | null
}

export type QuantityBreak = {
  minQuantity: number
  discountBp: number
}

export type Product = {
  sku: string
  name: string
  description: string
  category: string
  manufacturer: string
  unit: string
  basePriceCents: number
  status: ProductStatus
  /** Set on archived products that a live successor replaces. */
  replacementSku: string | null
  /** Set on deliberately confusable products that differ in one attribute. */
  nearDuplicateOf: string | null
  aliases: ProductAlias[]
  quantityBreaks: QuantityBreak[]
}

export type CustomerTier = "standard" | "preferred" | "key"

export type CustomerContact = {
  id: string
  name: string
  email: string
  phone: string
  role: string
}

export type CustomerLocation = {
  id: string
  label: string
  street: string
  postalCode: string
  city: string
  country: string
}

export type Customer = {
  id: string
  name: string
  domain: string
  tier: CustomerTier
  tierDiscountBp: number
  contacts: CustomerContact[]
  locations: CustomerLocation[]
}

export type PriceOverride = {
  customerId: string
  sku: string
  unitPriceCents: number
  effectiveFrom: string
  active: boolean
  reason: string
}

export type OrderLine = {
  position: number
  sku: string
  quantity: number
  unitPriceCents: number
  appliedRule: "override" | "tier" | "quantity_break" | "base"
}

export type Order = {
  id: string
  customerId: string
  contactId: string
  locationId: string
  orderedAt: string
  lines: OrderLine[]
}

export type Catalog = {
  seed: number
  products: Product[]
  customers: Customer[]
  priceOverrides: PriceOverride[]
  orders: Order[]
}

export const TIER_DISCOUNT_BP: Record<CustomerTier, number> = {
  standard: 0,
  preferred: 300,
  key: 650,
}

const PRODUCT_TARGET = 250
const CUSTOMER_TARGET = 25
const ORDER_TARGET = 150

/* -------------------------------------------------------------------------- */
/* Deterministic primitives                                                    */
/* -------------------------------------------------------------------------- */

type Random = () => number

function createRandom(seed: number): Random {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pickInt(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

function pick<T>(random: Random, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]
}

/** A deterministic ISO day stamp counted back from a fixed reference date. */
function isoDay(daysBeforeReference: number): string {
  const reference = Date.UTC(2026, 7, 1)
  const day = new Date(reference - daysBeforeReference * 86_400_000)
  return day.toISOString().slice(0, 10)
}

/** Swaps two adjacent characters, the most common real typing mistake. */
function transpose(value: string, index: number): string {
  if (index < 1 || index >= value.length) return value
  return (
    value.slice(0, index - 1) +
    value[index] +
    value[index - 1] +
    value.slice(index + 1)
  )
}

function doubleLetter(value: string, index: number): string {
  if (index >= value.length) return value
  return value.slice(0, index) + value[index] + value.slice(index)
}

/* -------------------------------------------------------------------------- */
/* Curated anchor products                                                     */
/* -------------------------------------------------------------------------- */

type AnchorProduct = {
  sku: string
  name: string
  description: string
  category: string
  manufacturer: string
  unit: string
  basePriceCents: number
  status?: ProductStatus
  replacementSku?: string
  nearDuplicateOf?: string
  aliases?: { alias: string; kind: AliasKind }[]
  quantityBreaks?: QuantityBreak[]
}

/**
 * The curated scenarios quote these SKUs directly, so they are authored rather
 * than generated. Everything the three requests need to be decidable —
 * aliases, typographical variants, near duplicates, archived predecessors —
 * lives here.
 */
const ANCHOR_PRODUCTS: AnchorProduct[] = [
  {
    sku: "NX-FLT-1120",
    name: "Pleated panel air filter 592 x 592 x 48 mm ISO Coarse 60%",
    description:
      "Disposable pleated panel filter for air handling units. Cardboard frame, synthetic media, ISO Coarse 60% (former G4).",
    category: "HVAC filtration",
    manufacturer: "Aeroline",
    unit: "piece",
    basePriceCents: 1490,
    aliases: [
      { alias: "panel filter 592x592x48", kind: "alias" },
      { alias: "G4 panel filter 592", kind: "legacy" },
      { alias: "pleeted panel filter 592x592", kind: "typo" },
    ],
    quantityBreaks: [
      { minQuantity: 12, discountBp: 400 },
      { minQuantity: 48, discountBp: 900 },
    ],
  },
  {
    sku: "NX-FLT-1121",
    name: "Pleated panel air filter 592 x 287 x 48 mm ISO Coarse 60%",
    description:
      "Half-size pleated panel filter for air handling units. Cardboard frame, synthetic media, ISO Coarse 60%.",
    category: "HVAC filtration",
    manufacturer: "Aeroline",
    unit: "piece",
    basePriceCents: 1090,
    nearDuplicateOf: "NX-FLT-1120",
    aliases: [{ alias: "panel filter 592x287x48", kind: "alias" }],
    quantityBreaks: [{ minQuantity: 12, discountBp: 400 }],
  },
  {
    sku: "NX-LUB-3040",
    name: "Multi-purpose lithium grease EP2, 400 g cartridge",
    description:
      "Lithium soap grease with extreme-pressure additives for bearings and general maintenance. 400 g cartridge.",
    category: "Lubricants",
    manufacturer: "Torvex",
    unit: "cartridge",
    basePriceCents: 640,
    aliases: [
      { alias: "EP2 grease cartridge 400g", kind: "alias" },
      { alias: "lithium grease 400 g", kind: "alias" },
    ],
    quantityBreaks: [
      { minQuantity: 12, discountBp: 500 },
      { minQuantity: 60, discountBp: 1100 },
    ],
  },
  {
    sku: "NX-LUB-3041",
    name: "Multi-purpose lithium grease EP2, 1 kg tin",
    description:
      "Lithium soap grease with extreme-pressure additives. 1 kg tin for workshop dispensing.",
    category: "Lubricants",
    manufacturer: "Torvex",
    unit: "tin",
    basePriceCents: 1280,
    nearDuplicateOf: "NX-LUB-3040",
    quantityBreaks: [{ minQuantity: 6, discountBp: 400 }],
  },
  {
    sku: "NX-SFT-2210",
    name: "Nitrile-coated knitted work glove, size 9",
    description:
      "Seamless knitted polyester glove with nitrile foam palm coating. EN 388 4131X. Size 9.",
    category: "Safety",
    manufacturer: "Gripwell",
    unit: "pair",
    basePriceCents: 320,
    aliases: [
      { alias: "nitrile work gloves size 9", kind: "alias" },
      { alias: "safety gloves size 9", kind: "alias" },
    ],
    quantityBreaks: [
      { minQuantity: 24, discountBp: 600 },
      { minQuantity: 120, discountBp: 1200 },
    ],
  },
  {
    sku: "NX-SFT-2211",
    name: "Nitrile-coated knitted work glove, size 10",
    description:
      "Seamless knitted polyester glove with nitrile foam palm coating. EN 388 4131X. Size 10.",
    category: "Safety",
    manufacturer: "Gripwell",
    unit: "pair",
    basePriceCents: 320,
    nearDuplicateOf: "NX-SFT-2210",
    quantityBreaks: [{ minQuantity: 24, discountBp: 600 }],
  },
  {
    sku: "NX-CLN-5015",
    name: "Industrial degreaser concentrate, 5 L canister",
    description:
      "Alkaline water-based degreaser concentrate for workshop floors and machinery. Dilution 1:20. 5 L canister.",
    category: "Cleaning",
    manufacturer: "Solventa",
    unit: "canister",
    basePriceCents: 2240,
    aliases: [{ alias: "degreaser 5l", kind: "alias" }],
    quantityBreaks: [{ minQuantity: 8, discountBp: 500 }],
  },
  {
    sku: "NX-FAS-4402",
    name: "Hexagon head bolt M10 x 60, zinc plated, box of 100",
    description:
      "DIN 933 hexagon head bolt, full thread, property class 8.8, zinc plated. Box of 100 pieces.",
    category: "Fasteners",
    manufacturer: "Steelbind",
    unit: "box",
    basePriceCents: 3180,
    aliases: [
      { alias: "M10x60 hex bolt zinc", kind: "alias" },
      { alias: "DIN 933 M10x60", kind: "alias" },
    ],
    quantityBreaks: [
      { minQuantity: 5, discountBp: 400 },
      { minQuantity: 20, discountBp: 850 },
    ],
  },
  {
    sku: "NX-FAS-4403",
    name: "Hexagon head bolt M10 x 70, zinc plated, box of 100",
    description:
      "DIN 933 hexagon head bolt, full thread, property class 8.8, zinc plated. Box of 100 pieces.",
    category: "Fasteners",
    manufacturer: "Steelbind",
    unit: "box",
    basePriceCents: 3390,
    nearDuplicateOf: "NX-FAS-4402",
    quantityBreaks: [{ minQuantity: 5, discountBp: 400 }],
  },
  {
    sku: "NX-ELC-7305",
    name: "LED tube 1200 mm, 18 W, 4000 K, G13",
    description:
      "Retrofit LED tube for T8 fittings. 1200 mm, 18 W, 2700 lm, neutral white 4000 K, G13 cap.",
    category: "Electrical",
    manufacturer: "Lumeria",
    unit: "piece",
    basePriceCents: 890,
    aliases: [
      { alias: "LED tube 120cm 18W", kind: "alias" },
      { alias: "T8 LED 1200mm 4000K", kind: "alias" },
    ],
    quantityBreaks: [
      { minQuantity: 25, discountBp: 700 },
      { minQuantity: 100, discountBp: 1300 },
    ],
  },
  {
    sku: "NX-ELC-7306",
    name: "LED tube 1500 mm, 24 W, 4000 K, G13",
    description:
      "Retrofit LED tube for T8 fittings. 1500 mm, 24 W, 3600 lm, neutral white 4000 K, G13 cap.",
    category: "Electrical",
    manufacturer: "Lumeria",
    unit: "piece",
    basePriceCents: 1180,
    nearDuplicateOf: "NX-ELC-7305",
    quantityBreaks: [{ minQuantity: 25, discountBp: 700 }],
  },
  {
    sku: "NX-DRV-6120",
    name: "V-belt SPA 1250 Lw, wrapped",
    description:
      "Wrapped narrow V-belt, SPA profile, 1250 mm datum length, for fan and pump drives.",
    category: "Power transmission",
    manufacturer: "Drivecore",
    unit: "piece",
    basePriceCents: 1540,
    aliases: [
      { alias: "SPA1250", kind: "alias" },
      { alias: "v belt SPA 1250", kind: "alias" },
    ],
    quantityBreaks: [{ minQuantity: 10, discountBp: 600 }],
  },
  {
    sku: "NX-DRV-6121",
    name: "V-belt SPA 1320 Lw, wrapped",
    description:
      "Wrapped narrow V-belt, SPA profile, 1320 mm datum length, for fan and pump drives.",
    category: "Power transmission",
    manufacturer: "Drivecore",
    unit: "piece",
    basePriceCents: 1620,
    nearDuplicateOf: "NX-DRV-6120",
  },
  {
    sku: "NX-PMP-8130",
    name: "Mechanical seal kit 32 mm, carbon / ceramic (discontinued)",
    description:
      "Superseded mechanical seal kit for 32 mm pump shafts. Discontinued; replaced by the silicon carbide version.",
    category: "Pumps and seals",
    manufacturer: "Hydroline",
    unit: "kit",
    basePriceCents: 4200,
    status: "archived",
    replacementSku: "NX-PMP-8140",
    aliases: [
      { alias: "45-221-B", kind: "legacy" },
      { alias: "seal kit 32mm carbon", kind: "alias" },
    ],
  },
  {
    sku: "NX-PMP-8140",
    name: "Mechanical seal kit 32 mm, silicon carbide",
    description:
      "Mechanical seal kit for 32 mm pump shafts with silicon carbide faces and EPDM elastomers. Successor to the carbon/ceramic kit.",
    category: "Pumps and seals",
    manufacturer: "Hydroline",
    unit: "kit",
    basePriceCents: 5150,
    aliases: [
      { alias: "seal kit 32mm SiC", kind: "alias" },
      { alias: "45-221-C", kind: "legacy" },
    ],
    quantityBreaks: [{ minQuantity: 4, discountBp: 500 }],
  },
  {
    sku: "NX-SEA-9120",
    name: "Flat gasket DN50 PTFE, 2 mm",
    description:
      "PTFE flat gasket for DN50 flanges, 2 mm thickness, PN16 dimensions.",
    category: "Pumps and seals",
    manufacturer: "Hydroline",
    unit: "piece",
    basePriceCents: 780,
    aliases: [{ alias: "PTFE gasket DN50", kind: "alias" }],
    quantityBreaks: [{ minQuantity: 20, discountBp: 600 }],
  },
  {
    sku: "NX-SEA-9121",
    name: "Flat gasket DN50 PTFE, 3 mm",
    description:
      "PTFE flat gasket for DN50 flanges, 3 mm thickness, PN16 dimensions.",
    category: "Pumps and seals",
    manufacturer: "Hydroline",
    unit: "piece",
    basePriceCents: 860,
    nearDuplicateOf: "NX-SEA-9120",
    aliases: [{ alias: "PTFE gasket DN50 3mm", kind: "alias" }],
  },
  {
    sku: "NX-BRG-3310",
    name: "Deep groove ball bearing 6205 2RS (discontinued)",
    description:
      "Superseded 25 x 52 x 15 mm deep groove ball bearing with rubber seals. Discontinued in favour of the low-friction version.",
    category: "Bearings",
    manufacturer: "Rollmark",
    unit: "piece",
    basePriceCents: 690,
    status: "archived",
    replacementSku: "NX-BRG-3311",
    aliases: [{ alias: "6205-2RS", kind: "legacy" }],
  },
  {
    sku: "NX-BRG-3311",
    name: "Deep groove ball bearing 6205 2RS1 low friction",
    description:
      "25 x 52 x 15 mm deep groove ball bearing with low-friction rubber seals. Replaces the previous 2RS version.",
    category: "Bearings",
    manufacturer: "Rollmark",
    unit: "piece",
    basePriceCents: 810,
    aliases: [{ alias: "6205 2RS1", kind: "alias" }],
    quantityBreaks: [{ minQuantity: 10, discountBp: 500 }],
  },
  {
    sku: "NX-HOS-2405",
    name: "Hydraulic hose assembly 1/2 in, 1500 mm, DKOL fittings",
    description:
      "Two-wire braided hydraulic hose assembly, 1/2 in bore, 1500 mm overall length, DKOL 22 fittings both ends.",
    category: "Hydraulics",
    manufacturer: "Hydroline",
    unit: "piece",
    basePriceCents: 3960,
    aliases: [{ alias: "hose 1/2 1500mm DKOL", kind: "alias" }],
  },
  {
    sku: "NX-HOS-2406",
    name: "Hydraulic hose assembly 1/2 in, 2000 mm, DKOL fittings",
    description:
      "Two-wire braided hydraulic hose assembly, 1/2 in bore, 2000 mm overall length, DKOL 22 fittings both ends.",
    category: "Hydraulics",
    manufacturer: "Hydroline",
    unit: "piece",
    basePriceCents: 4380,
    nearDuplicateOf: "NX-HOS-2405",
  },
  {
    sku: "NX-VLV-5520",
    name: "Ball valve DN25, brass, lever handle",
    description:
      "Full-bore brass ball valve, DN25 (1 in) female thread, PN25, steel lever handle.",
    category: "Plumbing",
    manufacturer: "Ventura",
    unit: "piece",
    basePriceCents: 1720,
    aliases: [{ alias: "1 inch ball valve brass", kind: "alias" }],
    quantityBreaks: [{ minQuantity: 10, discountBp: 500 }],
  },
  {
    sku: "NX-VLV-5521",
    name: "Ball valve DN32, brass, lever handle",
    description:
      "Full-bore brass ball valve, DN32 (1 1/4 in) female thread, PN25, steel lever handle.",
    category: "Plumbing",
    manufacturer: "Ventura",
    unit: "piece",
    basePriceCents: 2240,
    nearDuplicateOf: "NX-VLV-5520",
  },
  {
    sku: "NX-ABR-7710",
    name: "Cutting disc 125 x 1.0 mm for stainless steel, box of 25",
    description:
      "Thin cutting disc for angle grinders, 125 x 1.0 x 22.23 mm, INOX bonded. Box of 25 discs.",
    category: "Consumables",
    manufacturer: "Grindex",
    unit: "box",
    basePriceCents: 2650,
    aliases: [{ alias: "cutting discs 125 inox", kind: "alias" }],
    quantityBreaks: [{ minQuantity: 4, discountBp: 500 }],
  },
]

/* -------------------------------------------------------------------------- */
/* Generated catalogue families                                                */
/* -------------------------------------------------------------------------- */

type Family = {
  code: string
  category: string
  noun: string
  manufacturer: string
  unit: string
  variants: string[]
  basePriceCents: number
  priceStepCents: number
}

const FAMILIES: Family[] = [
  {
    code: "FLT",
    category: "HVAC filtration",
    noun: "Bag filter",
    manufacturer: "Aeroline",
    unit: "piece",
    variants: [
      "592 x 592 x 360 mm, 6 pockets",
      "592 x 287 x 360 mm, 3 pockets",
      "592 x 592 x 600 mm, 8 pockets",
      "490 x 592 x 360 mm, 5 pockets",
      "287 x 592 x 600 mm, 4 pockets",
      "592 x 592 x 300 mm, 6 pockets",
    ],
    basePriceCents: 2380,
    priceStepCents: 210,
  },
  {
    code: "FAS",
    category: "Fasteners",
    noun: "Hexagon nut",
    manufacturer: "Steelbind",
    unit: "box",
    variants: [
      "M6 zinc plated, box of 500",
      "M8 zinc plated, box of 250",
      "M10 zinc plated, box of 200",
      "M12 zinc plated, box of 100",
      "M8 stainless A2, box of 200",
      "M10 stainless A2, box of 100",
      "M16 zinc plated, box of 50",
    ],
    basePriceCents: 1450,
    priceStepCents: 320,
  },
  {
    code: "SFT",
    category: "Safety",
    noun: "Safety equipment",
    manufacturer: "Gripwell",
    unit: "piece",
    variants: [
      "clear safety spectacles, anti-fog",
      "ear defender, SNR 31 dB",
      "high-visibility vest, class 2, size L",
      "disposable coverall, type 5/6, size XL",
      "cut-resistant glove, level C, size 9",
      "safety helmet, vented, white",
    ],
    basePriceCents: 940,
    priceStepCents: 260,
  },
  {
    code: "ELC",
    category: "Electrical",
    noun: "Installation part",
    manufacturer: "Lumeria",
    unit: "piece",
    variants: [
      "cable gland M20, IP68, grey",
      "junction box 100 x 100 mm, IP55",
      "miniature circuit breaker B16, 1P",
      "socket outlet, surface, IP44",
      "flexible conduit 20 mm, per metre",
      "LED floodlight 30 W, 4000 K",
    ],
    basePriceCents: 780,
    priceStepCents: 430,
  },
  {
    code: "CLN",
    category: "Cleaning",
    noun: "Cleaning supply",
    manufacturer: "Solventa",
    unit: "piece",
    variants: [
      "sanitary cleaner concentrate, 1 L",
      "glass cleaner ready to use, 750 ml",
      "microfibre cloth, pack of 10",
      "floor pad 430 mm, red, pack of 5",
      "hand cleaning paste, 3 L",
      "absorbent granulate, 20 L sack",
    ],
    basePriceCents: 690,
    priceStepCents: 240,
  },
  {
    code: "LUB",
    category: "Lubricants",
    noun: "Lubricant",
    manufacturer: "Torvex",
    unit: "piece",
    variants: [
      "chain spray, 400 ml aerosol",
      "penetrating oil, 500 ml aerosol",
      "food-grade grease NSF H1, 400 g",
      "gear oil ISO VG 220, 5 L",
      "silicone spray, 400 ml aerosol",
      "hydraulic oil HLP 46, 20 L",
    ],
    basePriceCents: 860,
    priceStepCents: 380,
  },
  {
    code: "PLM",
    category: "Plumbing",
    noun: "Pipe fitting",
    manufacturer: "Ventura",
    unit: "piece",
    variants: [
      "compression elbow 22 mm, brass",
      "reducer 1 in to 3/4 in, brass",
      "pipe clamp 32 mm with rubber insert",
      "non-return valve DN20, brass",
      "flexible connector DN25, 300 mm",
      "drain trap 40 mm, polypropylene",
    ],
    basePriceCents: 640,
    priceStepCents: 290,
  },
  {
    code: "TLS",
    category: "Hand tools",
    noun: "Hand tool",
    manufacturer: "Grindex",
    unit: "piece",
    variants: [
      "combination spanner set, 8 to 22 mm",
      "adjustable wrench 250 mm",
      "torque wrench 20 to 100 Nm",
      "cable cutter 200 mm, insulated",
      "digital caliper 150 mm",
      "pipe wrench 300 mm",
    ],
    basePriceCents: 2450,
    priceStepCents: 940,
  },
  {
    code: "BRG",
    category: "Bearings",
    noun: "Bearing part",
    manufacturer: "Rollmark",
    unit: "piece",
    variants: [
      "6204 2RS, 20 x 47 x 14 mm",
      "6206 2RS, 30 x 62 x 16 mm",
      "6208 2RS, 40 x 80 x 18 mm",
      "plummer block housing SN505",
      "self-aligning bearing 1206",
      "needle roller bearing HK2020",
    ],
    basePriceCents: 980,
    priceStepCents: 470,
  },
  {
    code: "DRV",
    category: "Power transmission",
    noun: "Drive component",
    manufacturer: "Drivecore",
    unit: "piece",
    variants: [
      "timing belt HTD 8M 1200, 20 mm wide",
      "taper bush 2012, bore 25 mm",
      "chain 08B-1, per metre",
      "sprocket 08B-1, 19 teeth",
      "coupling element, size 24, 92 Sh A",
      "V-belt pulley SPA 125, 2 grooves",
    ],
    basePriceCents: 1860,
    priceStepCents: 620,
  },
]

/* -------------------------------------------------------------------------- */
/* Curated anchor customers                                                    */
/* -------------------------------------------------------------------------- */

type AnchorCustomer = {
  id: string
  name: string
  domain: string
  tier: CustomerTier
  contacts: { name: string; role: string; phone: string }[]
  locations: Omit<CustomerLocation, "id">[]
}

const ANCHOR_CUSTOMERS: AnchorCustomer[] = [
  {
    id: "CUST-1001",
    name: "Northline Property Services",
    domain: "northline-services.example",
    tier: "preferred",
    contacts: [
      { name: "Lena Vogt", role: "Procurement lead", phone: "+49 30 5550 118" },
      { name: "Tomas Berger", role: "Depot manager", phone: "+49 30 5550 124" },
      {
        name: "Ines Halbach",
        role: "Accounts payable",
        phone: "+49 30 5550 131",
      },
    ],
    locations: [
      {
        label: "Spandau service depot",
        street: "Falkenseer Chaussee 118",
        postalCode: "13583",
        city: "Berlin",
        country: "DE",
      },
      {
        label: "Head office",
        street: "Alt-Moabit 42",
        postalCode: "10555",
        city: "Berlin",
        country: "DE",
      },
    ],
  },
  {
    id: "CUST-1002",
    name: "Bergmann Facility Group",
    domain: "bergmann-facility.example",
    tier: "key",
    contacts: [
      {
        name: "Marta Klein",
        role: "Office coordinator",
        phone: "+49 221 5550 907",
      },
      {
        name: "Daniel Sauer",
        role: "Maintenance supervisor",
        phone: "+49 221 5550 912",
      },
      {
        name: "Petra Lindqvist",
        role: "Technical buyer",
        phone: "+49 221 5550 918",
      },
      { name: "Ove Brandt", role: "Site engineer", phone: "+49 221 5550 923" },
    ],
    locations: [
      {
        label: "South site",
        street: "Industriestrasse 7",
        postalCode: "50997",
        city: "Cologne",
        country: "DE",
      },
      {
        label: "North workshop",
        street: "Hafenweg 21",
        postalCode: "50735",
        city: "Cologne",
        country: "DE",
      },
      {
        label: "Central stores",
        street: "Am Gueterbahnhof 4",
        postalCode: "50679",
        city: "Cologne",
        country: "DE",
      },
    ],
  },
  {
    id: "CUST-1003",
    name: "Westmark Industrial Care",
    domain: "westmark-care.example",
    tier: "standard",
    contacts: [
      {
        name: "Jonas Richter",
        role: "Service technician",
        phone: "+31 20 5550 344",
      },
      { name: "Saskia Ohm", role: "Purchasing", phone: "+31 20 5550 351" },
    ],
    locations: [
      {
        label: "Amsterdam workshop",
        street: "Havenstraat 96",
        postalCode: "1013 AG",
        city: "Amsterdam",
        country: "NL",
      },
    ],
  },
]

const COMPANY_PREFIXES = [
  "Ostwind",
  "Kelder",
  "Rheinhof",
  "Brightpath",
  "Aldermann",
  "Vestrand",
  "Nordkap",
  "Silberhaus",
  "Cartwright",
  "Lindgren",
  "Fjordvik",
  "Halbritter",
  "Marschall",
  "Tegelberg",
  "Vandeveld",
  "Steinbach",
  "Roseneck",
  "Kirchmann",
  "Ahlmann",
  "Duvernay",
  "Wessling",
  "Norrhavn",
]

const COMPANY_SUFFIXES = [
  "Facility Services",
  "Property Care",
  "Industrial Maintenance",
  "Building Systems",
  "Technical Services",
  "Site Services",
  "Plant Care",
  "Estate Management",
]

const GIVEN_NAMES = [
  "Anke",
  "Bjorn",
  "Carla",
  "Dieter",
  "Elif",
  "Frank",
  "Greta",
  "Hendrik",
  "Ilse",
  "Joost",
  "Katrin",
  "Lars",
  "Miriam",
  "Nils",
  "Oda",
  "Pieter",
  "Rike",
  "Sven",
  "Tabea",
  "Ulf",
  "Vera",
  "Wim",
]

const FAMILY_NAMES = [
  "Adler",
  "Baumann",
  "Cramer",
  "Dahl",
  "Ebert",
  "Fuchs",
  "Grothe",
  "Hoffmann",
  "Ilgner",
  "Jansen",
  "Kohl",
  "Lammers",
  "Moser",
  "Neuhaus",
  "Oberle",
  "Pfeiffer",
  "Quandt",
  "Rothe",
  "Suess",
  "Thiel",
  "Ulrich",
  "Vetter",
]

const ROLES = [
  "Procurement lead",
  "Maintenance supervisor",
  "Technical buyer",
  "Site engineer",
  "Facility manager",
  "Workshop lead",
  "Accounts payable",
]

const LOCATION_LABELS = [
  "Head office",
  "Central stores",
  "North depot",
  "South depot",
  "Service workshop",
  "Logistics hub",
]

const STREETS = [
  "Industriestrasse",
  "Hafenweg",
  "Am Wasserturm",
  "Gewerbepark",
  "Ringstrasse",
  "Lagerweg",
  "Bahnhofsallee",
  "Kanalstrasse",
]

const CITIES: { city: string; postalPrefix: string; country: string }[] = [
  { city: "Hamburg", postalPrefix: "20", country: "DE" },
  { city: "Munich", postalPrefix: "80", country: "DE" },
  { city: "Leipzig", postalPrefix: "04", country: "DE" },
  { city: "Essen", postalPrefix: "45", country: "DE" },
  { city: "Rotterdam", postalPrefix: "30", country: "NL" },
  { city: "Utrecht", postalPrefix: "35", country: "NL" },
  { city: "Antwerp", postalPrefix: "20", country: "BE" },
  { city: "Graz", postalPrefix: "80", country: "AT" },
]

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

function slugEmail(name: string, domain: string): string {
  const [given, family] = name.split(" ")
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .replaceAll("ä", "ae")
      .replaceAll("ö", "oe")
      .replaceAll("ü", "ue")
      .replaceAll("ß", "ss")
      .replace(/[^a-z]/g, "")

  return `${normalise(given)}.${normalise(family)}@${domain}`
}

/** The product name without its series suffix: two products that share this
 * string are the same line in different generations. */
function seriesFamily(name: string): string {
  return name.replace(/ series \d+$/, "")
}

/** How many distinct words two product names have in common. Used to pick the
 * successor of an archived line that reads as the same thing. */
function sharedWordCount(left: string, right: string): number {
  const words = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9/]+/)
        .filter(Boolean)
    )

  const leftWords = words(left)
  let shared = 0
  for (const word of words(right)) {
    if (leftWords.has(word)) shared += 1
  }

  return shared
}

/** The series number in a product name, counting an unsuffixed name as one. */
function seriesNumber(name: string): number {
  const match = / series (\d+)$/.exec(name)
  return match ? Number(match[1]) : 1
}

/**
 * Ranks two candidate successors for an archived product: the closest name
 * wins, a later series of the same line beats an earlier one, and the SKU
 * breaks any remaining tie so the choice stays deterministic.
 */
function compareSuccessors(left: Product, right: Product, archived: Product) {
  const byName =
    sharedWordCount(right.name, archived.name) -
    sharedWordCount(left.name, archived.name)
  if (byName !== 0) return byName

  const sameLine = (candidate: Product) =>
    seriesFamily(candidate.name) === seriesFamily(archived.name)
  const rank = (candidate: Product) => {
    if (!sameLine(candidate)) return Number.MAX_SAFE_INTEGER
    const distance = seriesNumber(candidate.name) - seriesNumber(archived.name)
    return distance > 0 ? distance : 1000 - distance
  }

  const bySeries = rank(left) - rank(right)
  if (bySeries !== 0) return bySeries

  return left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0
}

function generateProducts(random: Random): Product[] {
  const products: Product[] = ANCHOR_PRODUCTS.map((anchor) => ({
    sku: anchor.sku,
    name: anchor.name,
    description: anchor.description,
    category: anchor.category,
    manufacturer: anchor.manufacturer,
    unit: anchor.unit,
    basePriceCents: anchor.basePriceCents,
    status: anchor.status ?? "active",
    replacementSku: anchor.replacementSku ?? null,
    nearDuplicateOf: anchor.nearDuplicateOf ?? null,
    aliases: (anchor.aliases ?? []).map((alias) => ({
      alias: alias.alias,
      kind: alias.kind,
      customerId: null,
    })),
    quantityBreaks: anchor.quantityBreaks ?? [],
  }))

  let sequence = 0

  while (products.length < PRODUCT_TARGET) {
    const family = FAMILIES[sequence % FAMILIES.length]
    const variantIndex = Math.floor(sequence / FAMILIES.length)
    const variant = family.variants[variantIndex % family.variants.length]
    const generation = Math.floor(variantIndex / family.variants.length)
    const number = 100 + sequence
    const sku = `NX-${family.code}-${number}`
    const grade = generation === 0 ? "" : ` series ${generation + 1}`
    const name = `${family.noun} ${variant}${grade}`
    const archived = sequence % 17 === 5

    const priceCents =
      family.basePriceCents +
      family.priceStepCents * (variantIndex % 7) +
      pickInt(random, 0, 9) * 10

    const aliases: ProductAlias[] = []
    const shortAlias =
      `${family.code} ${variant.split(",")[0]}${grade}`.toLowerCase()
    aliases.push({ alias: shortAlias, kind: "alias", customerId: null })

    if (sequence % 3 === 0) {
      aliases.push({
        alias: transpose(shortAlias, pickInt(random, 2, shortAlias.length - 1)),
        kind: "typo",
        customerId: null,
      })
    }

    if (sequence % 5 === 2) {
      aliases.push({
        alias: `${family.code}-${number}-OLD`,
        kind: "legacy",
        customerId: null,
      })
    }

    const quantityBreaks: QuantityBreak[] =
      sequence % 4 === 0
        ? [
            { minQuantity: 10, discountBp: 300 + (sequence % 3) * 100 },
            { minQuantity: 50, discountBp: 800 + (sequence % 4) * 100 },
          ]
        : sequence % 4 === 1
          ? [{ minQuantity: 25, discountBp: 500 }]
          : []

    products.push({
      sku,
      name,
      description: `${family.noun} for industrial and facilities maintenance: ${variant}. Stocked line from ${family.manufacturer}.`,
      category: family.category,
      manufacturer: family.manufacturer,
      unit: family.unit,
      basePriceCents: priceCents,
      status: archived ? "archived" : "active",
      replacementSku: null,
      nearDuplicateOf: null,
      aliases,
      quantityBreaks,
    })

    sequence += 1
  }

  // Deliberate near duplicates: a handful of generated lines are paired with the
  // later series of the very same line, so the two differ in nothing a request
  // usually states. The pair always sits inside one family, which is what makes
  // reranking hard without making the catalogue absurd.
  const firstGenerated = ANCHOR_PRODUCTS.length

  for (let index = firstGenerated; index < products.length; index += 17) {
    const source = products[index]
    if (source.nearDuplicateOf || source.status !== "active") continue

    const sibling = products.find(
      (candidate, position) =>
        position > index &&
        candidate.status === "active" &&
        !candidate.nearDuplicateOf &&
        candidate.category === source.category &&
        candidate.manufacturer === source.manufacturer &&
        seriesFamily(candidate.name) === seriesFamily(source.name)
    )
    if (!sibling) continue

    sibling.nearDuplicateOf = source.sku
  }

  // Archived lines that have a live successor: the closest active product in the
  // same family, so a superseded number always leads somewhere a buyer would
  // accept as the same thing.
  for (const product of products) {
    if (product.status !== "archived" || product.replacementSku) continue

    const candidates = products.filter(
      (candidate) =>
        candidate.status === "active" &&
        candidate.sku !== product.sku &&
        candidate.category === product.category &&
        candidate.manufacturer === product.manufacturer
    )

    const successor = candidates.sort((left, right) =>
      compareSuccessors(left, right, product)
    )[0]

    product.replacementSku = successor ? successor.sku : null
  }

  // A doubled letter somewhere in the catalogue keeps fuzzy retrieval honest.
  for (let index = 30; index < products.length; index += 23) {
    const product = products[index]
    product.aliases.push({
      alias: doubleLetter(product.name.toLowerCase(), 4),
      kind: "typo",
      customerId: null,
    })
  }

  return products
}

function generateCustomers(random: Random): Customer[] {
  const customers: Customer[] = ANCHOR_CUSTOMERS.map((anchor) => ({
    id: anchor.id,
    name: anchor.name,
    domain: anchor.domain,
    tier: anchor.tier,
    tierDiscountBp: TIER_DISCOUNT_BP[anchor.tier],
    contacts: anchor.contacts.map((contact, index) => ({
      id: `${anchor.id}-C${index + 1}`,
      name: contact.name,
      email: slugEmail(contact.name, anchor.domain),
      phone: contact.phone,
      role: contact.role,
    })),
    locations: anchor.locations.map((location, index) => ({
      id: `${anchor.id}-L${index + 1}`,
      ...location,
    })),
  }))

  let sequence = 0

  while (customers.length < CUSTOMER_TARGET) {
    const id = `CUST-${1004 + sequence}`
    const prefix = COMPANY_PREFIXES[sequence % COMPANY_PREFIXES.length]
    const suffix = pick(random, COMPANY_SUFFIXES)
    const name = `${prefix} ${suffix}`
    const domain = `${prefix.toLowerCase()}-${suffix.split(" ")[0].toLowerCase()}.example`
    const tier: CustomerTier =
      sequence % 7 === 0 ? "key" : sequence % 3 === 0 ? "preferred" : "standard"

    const contactCount = pickInt(random, 2, 4)
    const contacts: CustomerContact[] = []
    for (let index = 0; index < contactCount; index += 1) {
      const contactName = `${GIVEN_NAMES[(sequence * 3 + index) % GIVEN_NAMES.length]} ${
        FAMILY_NAMES[(sequence * 5 + index) % FAMILY_NAMES.length]
      }`
      contacts.push({
        id: `${id}-C${index + 1}`,
        name: contactName,
        email: slugEmail(contactName, domain),
        phone: `+49 ${200 + (sequence % 90)} 5550 ${100 + index * 7 + sequence}`,
        role: ROLES[(sequence + index) % ROLES.length],
      })
    }

    const locationCount = pickInt(random, 1, 3)
    const locations: CustomerLocation[] = []
    for (let index = 0; index < locationCount; index += 1) {
      const place = CITIES[(sequence + index) % CITIES.length]
      locations.push({
        id: `${id}-L${index + 1}`,
        label: LOCATION_LABELS[(sequence + index) % LOCATION_LABELS.length],
        street: `${STREETS[(sequence * 2 + index) % STREETS.length]} ${
          3 + ((sequence * 7 + index * 5) % 140)
        }`,
        postalCode: `${place.postalPrefix}${100 + ((sequence * 13 + index) % 800)}`,
        city: place.city,
        country: place.country,
      })
    }

    customers.push({
      id,
      name,
      domain,
      tier,
      tierDiscountBp: TIER_DISCOUNT_BP[tier],
      contacts,
      locations,
    })

    sequence += 1
  }

  return customers
}

/**
 * Customer-specific aliases: the wording a particular buyer keeps using for a
 * product, which customer resolution and catalogue matching can both learn from.
 */
function attachCustomerAliases(
  products: Product[],
  customers: Customer[]
): void {
  const customerAliases: { sku: string; customerId: string; alias: string }[] =
    [
      {
        sku: "NX-FLT-1120",
        customerId: "CUST-1001",
        alias: "standard depot filter",
      },
      {
        sku: "NX-PMP-8140",
        customerId: "CUST-1002",
        alias: "pump seal set south site",
      },
      {
        sku: "NX-SEA-9120",
        customerId: "CUST-1003",
        alias: "thin flange gasket",
      },
    ]

  for (const entry of customerAliases) {
    const product = products.find((candidate) => candidate.sku === entry.sku)
    const customer = customers.find(
      (candidate) => candidate.id === entry.customerId
    )
    if (!product || !customer) continue

    product.aliases.push({
      alias: entry.alias,
      kind: "customer",
      customerId: customer.id,
    })
  }
}

function generatePriceOverrides(
  random: Random,
  products: Product[],
  customers: Customer[]
): PriceOverride[] {
  const overrides: PriceOverride[] = [
    {
      customerId: "CUST-1001",
      sku: "NX-FLT-1120",
      unitPriceCents: 1290,
      effectiveFrom: isoDay(210),
      active: true,
      reason: "Annual filter agreement",
    },
    {
      customerId: "CUST-1002",
      sku: "NX-SFT-2210",
      unitPriceCents: 275,
      effectiveFrom: isoDay(160),
      active: true,
      reason: "Framework price, gloves",
    },
    {
      customerId: "CUST-1002",
      sku: "NX-PMP-8140",
      unitPriceCents: 4750,
      effectiveFrom: isoDay(95),
      active: true,
      reason: "Negotiated seal-kit price",
    },
    {
      customerId: "CUST-1003",
      sku: "NX-SEA-9120",
      unitPriceCents: 720,
      effectiveFrom: isoDay(400),
      active: false,
      reason: "Expired project price",
    },
  ]

  const activeProducts = products.filter(
    (product) => product.status === "active"
  )

  for (let index = 3; index < customers.length; index += 1) {
    const customer = customers[index]
    const overrideCount = pickInt(random, 0, 2)

    for (let entry = 0; entry < overrideCount; entry += 1) {
      const product =
        activeProducts[(index * 11 + entry * 37) % activeProducts.length]
      if (
        overrides.some(
          (existing) =>
            existing.customerId === customer.id && existing.sku === product.sku
        )
      ) {
        continue
      }

      const discount = pickInt(random, 4, 14) / 100
      overrides.push({
        customerId: customer.id,
        sku: product.sku,
        unitPriceCents: Math.round(product.basePriceCents * (1 - discount)),
        effectiveFrom: isoDay(pickInt(random, 30, 500)),
        active: entry === 0,
        reason: entry === 0 ? "Negotiated line price" : "Superseded price",
      })
    }
  }

  return overrides
}

function priceFor(
  product: Product,
  customer: Customer,
  quantity: number,
  overrides: PriceOverride[]
): { unitPriceCents: number; appliedRule: OrderLine["appliedRule"] } {
  const override = overrides.find(
    (entry) =>
      entry.active &&
      entry.customerId === customer.id &&
      entry.sku === product.sku
  )
  if (override) {
    return { unitPriceCents: override.unitPriceCents, appliedRule: "override" }
  }

  const quantityBreak = [...product.quantityBreaks]
    .sort((left, right) => right.minQuantity - left.minQuantity)
    .find((entry) => quantity >= entry.minQuantity)

  if (quantityBreak && quantityBreak.discountBp > customer.tierDiscountBp) {
    return {
      unitPriceCents: Math.round(
        (product.basePriceCents * (10_000 - quantityBreak.discountBp)) / 10_000
      ),
      appliedRule: "quantity_break",
    }
  }

  if (customer.tierDiscountBp > 0) {
    return {
      unitPriceCents: Math.round(
        (product.basePriceCents * (10_000 - customer.tierDiscountBp)) / 10_000
      ),
      appliedRule: "tier",
    }
  }

  return { unitPriceCents: product.basePriceCents, appliedRule: "base" }
}

function generateOrders(
  random: Random,
  products: Product[],
  customers: Customer[],
  overrides: PriceOverride[]
): Order[] {
  const orders: Order[] = []
  const sellable = products.filter((product) => product.status === "active")

  for (let index = 0; index < ORDER_TARGET; index += 1) {
    const customer = customers[index % customers.length]
    const contact = customer.contacts[index % customer.contacts.length]
    const location = customer.locations[index % customer.locations.length]
    const lineCount = pickInt(random, 1, 5)
    const lines: OrderLine[] = []

    for (let position = 0; position < lineCount; position += 1) {
      const product = sellable[(index * 7 + position * 29) % sellable.length]
      if (lines.some((line) => line.sku === product.sku)) continue

      const quantity = pick(random, [1, 2, 4, 5, 10, 12, 24, 25, 50, 100])
      const { unitPriceCents, appliedRule } = priceFor(
        product,
        customer,
        quantity,
        overrides
      )

      lines.push({
        position: lines.length + 1,
        sku: product.sku,
        quantity,
        unitPriceCents,
        appliedRule,
      })
    }

    orders.push({
      id: `ORD-${20_000 + index}`,
      customerId: customer.id,
      contactId: contact.id,
      locationId: location.id,
      orderedAt: isoDay(7 + index * 3),
      lines,
    })
  }

  // History that justifies the curated pricing decisions: the anchor customers
  // have recently bought exactly the products their RFQ asks about.
  const anchorHistory: { customerId: string; skus: string[] }[] = [
    { customerId: "CUST-1001", skus: ["NX-FLT-1120", "NX-LUB-3040"] },
    { customerId: "CUST-1002", skus: ["NX-SFT-2210", "NX-PMP-8140"] },
    { customerId: "CUST-1003", skus: ["NX-SEA-9120", "NX-BRG-3311"] },
  ]

  anchorHistory.forEach((entry, index) => {
    const customer = customers.find(
      (candidate) => candidate.id === entry.customerId
    )
    if (!customer) return
    const order = orders[index]
    order.customerId = customer.id
    order.contactId = customer.contacts[0].id
    order.locationId = customer.locations[0].id
    order.lines = entry.skus.map((sku, position) => {
      const product = products.find((candidate) => candidate.sku === sku)!
      const quantity = position === 0 ? 24 : 6
      const { unitPriceCents, appliedRule } = priceFor(
        product,
        customer,
        quantity,
        overrides
      )
      return {
        position: position + 1,
        sku,
        quantity,
        unitPriceCents,
        appliedRule,
      }
    })
  })

  return orders
}

/** Builds the complete synthetic dataset for a seed. Pure and repeatable. */
export function generateCatalog(seed: number = CATALOG_SEED): Catalog {
  const random = createRandom(seed)
  const products = generateProducts(random)
  const customers = generateCustomers(random)
  attachCustomerAliases(products, customers)
  const priceOverrides = generatePriceOverrides(random, products, customers)
  const orders = generateOrders(random, products, customers, priceOverrides)

  return { seed, products, customers, priceOverrides, orders }
}

/**
 * A stable content fingerprint (FNV-1a over the canonical JSON form). Tests pin
 * this so an accidental change to generation is caught before it reaches the
 * committed seed SQL or the gold fixtures.
 */
export function catalogFingerprint(catalog: Catalog): string {
  const json = JSON.stringify(catalog)
  let hash = 0x811c9dc5

  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, "0")
}
