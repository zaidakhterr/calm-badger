/**
 * The three curated RFQ scenarios.
 *
 * Each one is a complete, invented request: a forwarded email body, an inline
 * photograph, a PDF item list, six requested lines, and a plain statement of
 * why it is easy or hard. The customers, contacts, and part numbers all point
 * at the synthetic dataset in `worker/catalog/dataset.ts`; none of it refers to
 * a real company, customer, or document.
 *
 * The expected outcomes for these requests are not here. They live beside the
 * tests in `test/fixtures/gold-scenarios.ts` so that nothing in the runtime can
 * read an answer instead of producing one.
 *
 * This module is self-contained (no imports): the asset build script loads it
 * directly through Node type stripping, which cannot resolve extensionless
 * relative specifiers.
 */

export const SCENARIO_IDS = [
  "routine-replenishment",
  "messy-forwarded-request",
  "ambiguous-replacement-parts",
] as const

export type ScenarioId = (typeof SCENARIO_IDS)[number]

export type ScenarioDifficultyLevel = "Low" | "Medium" | "High"

export type RequestedItem = {
  position: number
  /** The product reference exactly as the request writes it. */
  reference: string
  description: string
  quantity: number
  unit: string
  /** What makes this line easy or hard, in the reviewer's language. */
  note: string
}

export type ScenarioAttachment = {
  kind: "pdf" | "image"
  filename: string
  /** Static asset path served by the Worker. */
  url: string
  title: string
  caption: string
}

export type Scenario = {
  id: ScenarioId
  name: string
  /** Exactly one scenario is featured and selected by default. */
  featured: boolean
  sources: string
  difficulty: {
    level: ScenarioDifficultyLevel
    summary: string
    expectedReview: string
  }
  email: {
    from: { name: string; email: string; company: string }
    to: string
    subject: string
    receivedAt: string
    /** Present when the reviewer is reading a forwarded thread. */
    forwarded: { from: string; date: string; subject: string } | null
    body: string[]
    signature: string[]
  }
  inlineImage: ScenarioAttachment
  pdfAttachment: ScenarioAttachment
  requestedItems: RequestedItem[]
  /** Lines rendered into the synthetic PDF attachment. */
  pdfLines: string[]
  /** Short label text rendered into the synthetic inline photograph. */
  imageLines: string[]
}

const SALES_INBOX = "sales@relay-supply.example"

export const SCENARIOS: Scenario[] = [
  {
    id: "routine-replenishment",
    name: "Routine replenishment",
    featured: false,
    sources: "Email · PDF · photo",
    difficulty: {
      level: "Low",
      summary:
        "A known contact writes from a known domain, quotes current article numbers, and names one delivery address. Every line should match on the article number alone.",
      expectedReview: "Expected to complete without human review.",
    },
    email: {
      from: {
        name: "Lena Vogt",
        email: "lena.vogt@northline-services.example",
        company: "Northline Property Services",
      },
      to: SALES_INBOX,
      subject: "Replenishment request August - Spandau depot",
      receivedAt: "2026-08-03T07:42:00Z",
      forwarded: null,
      body: [
        "Good morning,",
        "Please quote our usual August replenishment for the Spandau service depot. The list is attached as a PDF; the six positions are the same articles we ordered in spring.",
        "Delivery to the depot as always, and please confirm the price for the panel filters under our filter agreement.",
        "The photo shows the shelf label at the depot so there is no confusion about the filter size.",
      ],
      signature: [
        "Kind regards",
        "Lena Vogt",
        "Procurement lead, Northline Property Services",
        "+49 30 5550 118",
      ],
    },
    inlineImage: {
      kind: "image",
      filename: "shelf-label.png",
      url: "/scenarios/routine-replenishment/shelf-label.png",
      title: "Depot shelf label",
      caption:
        "Photograph of the depot shelf label confirming the filter size.",
    },
    pdfAttachment: {
      kind: "pdf",
      filename: "replenishment-list.pdf",
      url: "/scenarios/routine-replenishment/replenishment-list.pdf",
      title: "Replenishment list, August",
      caption: "Six positions with current article numbers and quantities.",
    },
    requestedItems: [
      {
        position: 1,
        reference: "NX-FLT-1120",
        description: "Panel filter 592 x 592 x 48",
        quantity: 24,
        unit: "pieces",
        note: "Exact article number; a customer price agreement applies.",
      },
      {
        position: 2,
        reference: "NX-LUB-3040",
        description: "Lithium grease EP2, 400 g cartridge",
        quantity: 12,
        unit: "cartridges",
        note: "Exact article number; quantity reaches the first break.",
      },
      {
        position: 3,
        reference: "NX-SFT-2210",
        description: "Nitrile work gloves, size 9",
        quantity: 24,
        unit: "pairs",
        note: "Exact article number; size 10 exists as a near duplicate.",
      },
      {
        position: 4,
        reference: "NX-CLN-5015",
        description: "Industrial degreaser concentrate, 5 L",
        quantity: 4,
        unit: "canisters",
        note: "Exact article number, below the quantity break.",
      },
      {
        position: 5,
        reference: "NX-FAS-4402",
        description: "Hex bolt M10 x 60 zinc, box of 100",
        quantity: 5,
        unit: "boxes",
        note: "Exact article number; the M10 x 70 box is a near duplicate.",
      },
      {
        position: 6,
        reference: "NX-ELC-7305",
        description: "LED tube 1200 mm, 18 W, 4000 K",
        quantity: 30,
        unit: "pieces",
        note: "Exact article number; quantity reaches the first break.",
      },
    ],
    pdfLines: [
      "NORTHLINE PROPERTY SERVICES",
      "REPLENISHMENT LIST - AUGUST",
      "DELIVERY: SPANDAU SERVICE DEPOT, BERLIN",
      "",
      "POS  ARTICLE       DESCRIPTION                      QTY  UNIT",
      "1    NX-FLT-1120   PANEL FILTER 592X592X48          24   PIECES",
      "2    NX-LUB-3040   LITHIUM GREASE EP2 400G          12   CARTRIDGES",
      "3    NX-SFT-2210   NITRILE WORK GLOVES SIZE 9       24   PAIRS",
      "4    NX-CLN-5015   DEGREASER CONCENTRATE 5L          4   CANISTERS",
      "5    NX-FAS-4402   HEX BOLT M10X60 ZINC BOX 100      5   BOXES",
      "6    NX-ELC-7305   LED TUBE 1200MM 18W 4000K        30   PIECES",
      "",
      "PLEASE CONFIRM PRICES AND DELIVERY WEEK.",
      "SYNTHETIC DEMONSTRATION DOCUMENT - NOT A REAL ORDER",
    ],
    imageLines: [
      "SHELF 04 / DEPOT SPANDAU",
      "NX-FLT-1120",
      "PANEL FILTER 592X592X48",
      "MIN STOCK 12 PIECES",
    ],
  },
  {
    id: "messy-forwarded-request",
    name: "Messy forwarded request",
    featured: true,
    sources: "Forwarded email · PDF · photo",
    difficulty: {
      level: "High",
      summary:
        "A forwarded thread with two senders, a misspelled product name, a superseded item number, and a gasket description that fits two stocked thicknesses. Quantities sit in the forwarded note rather than the list.",
      expectedReview:
        "Expect human review on the superseded item number and the gasket.",
    },
    email: {
      from: {
        name: "Marta Klein",
        email: "marta.klein@bergmann-facility.example",
        company: "Bergmann Facility Group",
      },
      to: SALES_INBOX,
      subject: "Fwd: parts for the maintenance round, south site",
      receivedAt: "2026-08-05T13:18:00Z",
      forwarded: {
        from: "Daniel Sauer <daniel.sauer@bergmann-facility.example>",
        date: "5 August 2026 at 11:52",
        subject: "parts for the maintenance round",
      },
      body: [
        "Hello,",
        "Could you price the list below for the south site? I am forwarding Daniel's note as it came in; the quantities are his, not mine.",
        "The photo is the nameplate of the pump seal he means. I am not sure the old item number is still current - it is from the folder we inherited.",
        "--- Forwarded message ---",
        "Marta, for the round next week we need: 16 pleeted panel filter 592x592, 12 EP2 grease cartridge 400g, 4 SPA1250 v-belt, 2 of the old item nr 45-221-B for the pump, 60 safety gloves size 9 nitrile and 20 flat gasket DN50 PTFE. The gaskets are the thin ones I think, whatever we had last time.",
        "Attached list is the same but without the amounts. Thanks, Daniel",
      ],
      signature: [
        "Best regards",
        "Marta Klein",
        "Office coordinator, Bergmann Facility Group",
      ],
    },
    inlineImage: {
      kind: "image",
      filename: "pump-nameplate.png",
      url: "/scenarios/messy-forwarded-request/pump-nameplate.png",
      title: "Pump nameplate photo",
      caption:
        "Photograph of the pump nameplate carrying the superseded item number.",
    },
    pdfAttachment: {
      kind: "pdf",
      filename: "maintenance-round-list.pdf",
      url: "/scenarios/messy-forwarded-request/maintenance-round-list.pdf",
      title: "Maintenance round list",
      caption: "Six positions without quantities, as sent by the site.",
    },
    requestedItems: [
      {
        position: 1,
        reference: "pleeted panel filter 592x592",
        description: "Misspelled description, no article number",
        quantity: 16,
        unit: "pieces",
        note: "Typographical variant of a stocked panel filter.",
      },
      {
        position: 2,
        reference: "EP2 grease cartridge 400g",
        description: "Known trade shorthand",
        quantity: 12,
        unit: "cartridges",
        note: "Matches a known alias exactly.",
      },
      {
        position: 3,
        reference: "SPA1250 v-belt",
        description: "Profile and length only",
        quantity: 4,
        unit: "pieces",
        note: "Alias match; the SPA 1320 belt sits next to it in the catalogue.",
      },
      {
        position: 4,
        reference: "old item nr 45-221-B",
        description: "Item number from an inherited folder",
        quantity: 2,
        unit: "kits",
        note: "Legacy number for an archived seal kit that has a successor.",
      },
      {
        position: 5,
        reference: "safety gloves size 9 nitrile",
        description: "Description only, correct size",
        quantity: 60,
        unit: "pairs",
        note: "Alias match; the quantity passes the second break.",
      },
      {
        position: 6,
        reference: "flat gasket DN50 PTFE",
        description: "Thickness left open",
        quantity: 20,
        unit: "pieces",
        note: "Fits both the 2 mm and the 3 mm gasket.",
      },
    ],
    pdfLines: [
      "BERGMANN FACILITY GROUP",
      "MAINTENANCE ROUND - SOUTH SITE",
      "PREPARED BY D. SAUER",
      "",
      "POS  DESCRIPTION AS WRITTEN",
      "1    PLEETED PANEL FILTER 592X592",
      "2    EP2 GREASE CARTRIDGE 400G",
      "3    SPA1250 V-BELT",
      "4    OLD ITEM NR 45-221-B (PUMP SEAL)",
      "5    SAFETY GLOVES SIZE 9 NITRILE",
      "6    FLAT GASKET DN50 PTFE",
      "",
      "AMOUNTS ARE IN THE MAIL, NOT ON THIS SHEET.",
      "SYNTHETIC DEMONSTRATION DOCUMENT - NOT A REAL ORDER",
    ],
    imageLines: [
      "PUMP UNIT SOUTH SITE",
      "SEAL KIT 45-221-B",
      "SHAFT 32 MM",
      "REPLACE WITH CURRENT TYPE",
    ],
  },
  {
    id: "ambiguous-replacement-parts",
    name: "Ambiguous replacement parts",
    featured: false,
    sources: "Email · PDF · photo",
    difficulty: {
      level: "Medium",
      summary:
        "A technician describes worn parts from measurements. Five of the six lines have a near-duplicate sibling that differs only in one dimension, and one label is unreadable except for its last four digits.",
      expectedReview: "Expect human confirmation on the near-duplicate lines.",
    },
    email: {
      from: {
        name: "Jonas Richter",
        email: "jonas.richter@westmark-care.example",
        company: "Westmark Industrial Care",
      },
      to: SALES_INBOX,
      subject: "Quote needed: replacement parts, Amsterdam workshop",
      receivedAt: "2026-08-06T09:05:00Z",
      forwarded: null,
      body: [
        "Hello,",
        "We stripped a conveyor drive yesterday and need replacements. Some labels are worn, so I took the measurements myself and wrote them on the attached sheet.",
        "The photo is the only label that is still partly readable - the last digits are 7305, the rest is gone. It is one of the 1200 mm tubes above the bench, if that helps.",
        "Please quote for the Amsterdam workshop and tell me if a different length is the better fit.",
      ],
      signature: [
        "Thanks",
        "Jonas Richter",
        "Service technician, Westmark Industrial Care",
      ],
    },
    inlineImage: {
      kind: "image",
      filename: "worn-label.png",
      url: "/scenarios/ambiguous-replacement-parts/worn-label.png",
      title: "Worn label photo",
      caption: "Photograph of a partly readable label ending in 7305.",
    },
    pdfAttachment: {
      kind: "pdf",
      filename: "replacement-sheet.pdf",
      url: "/scenarios/ambiguous-replacement-parts/replacement-sheet.pdf",
      title: "Replacement parts sheet",
      caption: "Six positions written from measurements taken on site.",
    },
    requestedItems: [
      {
        position: 1,
        reference: "6205-2RS bearing",
        description: "Bearing designation from the old seal",
        quantity: 10,
        unit: "pieces",
        note: "Legacy designation of an archived bearing with a successor.",
      },
      {
        position: 2,
        reference: "flange gasket DN50, 3 mm",
        description: "Thickness measured on site",
        quantity: 12,
        unit: "pieces",
        note: "Thickness separates it from the 2 mm near duplicate.",
      },
      {
        position: 3,
        reference: "hydraulic hose 1/2 inch, approx 2 m, DKOL",
        description: "Approximate length",
        quantity: 2,
        unit: "pieces",
        note: "1500 mm and 2000 mm assemblies both exist.",
      },
      {
        position: 4,
        reference: "LED tube, label ends 7305, 1200 mm",
        description: "Partly readable label",
        quantity: 8,
        unit: "pieces",
        note: "The 1500 mm tube is the near duplicate to rule out.",
      },
      {
        position: 5,
        reference: "ball valve 1 1/4 inch brass",
        description: "Imperial size given",
        quantity: 6,
        unit: "pieces",
        note: "DN32, not the DN25 valve carrying the imperial alias.",
      },
      {
        position: 6,
        reference: "hex bolts M10, 70 long, zinc, one box",
        description: "Length written informally",
        quantity: 1,
        unit: "box",
        note: "M10 x 70, not the M10 x 60 box.",
      },
    ],
    pdfLines: [
      "WESTMARK INDUSTRIAL CARE",
      "REPLACEMENT PARTS - CONVEYOR DRIVE",
      "AMSTERDAM WORKSHOP",
      "",
      "POS  AS MEASURED ON SITE                        QTY",
      "1    6205-2RS BEARING                           10",
      "2    FLANGE GASKET DN50, 3 MM                   12",
      "3    HYDRAULIC HOSE 1/2 INCH APPROX 2 M DKOL     2",
      "4    LED TUBE LABEL ENDS 7305, 1200 MM           8",
      "5    BALL VALVE 1 1/4 INCH BRASS                 6",
      "6    HEX BOLTS M10, 70 LONG, ZINC, ONE BOX       1",
      "",
      "MEASUREMENTS TAKEN BY HAND, PLEASE CONFIRM.",
      "SYNTHETIC DEMONSTRATION DOCUMENT - NOT A REAL ORDER",
    ],
    imageLines: [
      "LABEL PARTLY WORN",
      "NX-ELC-XXXX",
      "ENDS 7305",
      "TUBE 1200 MM 18W",
    ],
  },
]

export function isScenarioId(value: unknown): value is ScenarioId {
  return (
    typeof value === "string" &&
    (SCENARIO_IDS as readonly string[]).includes(value)
  )
}

export function findScenario(id: ScenarioId): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Unknown scenario: ${id}`)
  return scenario
}

/**
 * The scenario shape the landing page receives. It is the same material a
 * reviewer can see in the email itself; expected outcomes stay out of it.
 */
export type ScenarioPreview = Omit<Scenario, "pdfLines" | "imageLines">

export function scenarioPreviews(): ScenarioPreview[] {
  return SCENARIOS.map(({ pdfLines, imageLines, ...preview }) => {
    void pdfLines
    void imageLines
    return preview
  })
}
