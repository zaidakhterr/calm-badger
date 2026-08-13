/**
 * Curated scenario attachments.
 *
 * Each scenario ships a real PDF and a real image so the demo reads documents
 * rather than pasted text. The committed bytes must stay small, obviously
 * synthetic, and reproducible from the scenario definition.
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const { SCENARIOS } = await import("../worker/scenarios.ts")
const { renderScenarioAssets } =
  await import("../scripts/build-scenario-assets.mjs")

const MAX_ASSET_BYTES = 64 * 1024

const committed = (scenario, filename) =>
  readFileSync(`${repoRoot}public/scenarios/${scenario.id}/${filename}`)

test("every scenario ships a PDF and an inline image", () => {
  assert.equal(SCENARIOS.length, 3)

  for (const scenario of SCENARIOS) {
    const pdf = committed(scenario, scenario.pdfAttachment.filename)
    const image = committed(scenario, scenario.inlineImage.filename)

    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-")
    assert.deepEqual(
      [...image.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    )

    assert.ok(pdf.length < MAX_ASSET_BYTES, `${scenario.id} PDF is too large`)
    assert.ok(
      image.length < MAX_ASSET_BYTES,
      `${scenario.id} image is too large`
    )

    assert.equal(
      scenario.pdfAttachment.url,
      `/scenarios/${scenario.id}/${scenario.pdfAttachment.filename}`
    )
    assert.equal(
      scenario.inlineImage.url,
      `/scenarios/${scenario.id}/${scenario.inlineImage.filename}`
    )
  }
})

test("the committed assets are reproducible from the scenario definitions", () => {
  for (const scenario of SCENARIOS) {
    const rebuilt = renderScenarioAssets(scenario)

    assert.deepEqual(
      committed(scenario, rebuilt.pdf.filename),
      rebuilt.pdf.bytes,
      `${scenario.id} PDF is stale — run \`pnpm assets:build\``
    )
    assert.deepEqual(
      committed(scenario, rebuilt.image.filename),
      rebuilt.image.bytes,
      `${scenario.id} image is stale — run \`pnpm assets:build\``
    )
  }
})

test("the PDF carries the requested lines and a synthetic marker", () => {
  for (const scenario of SCENARIOS) {
    const pdf = committed(scenario, scenario.pdfAttachment.filename).toString(
      "latin1"
    )

    for (const line of scenario.pdfLines.filter(Boolean)) {
      // Text operands escape their parentheses inside the content stream.
      const encoded = line.replaceAll("(", "\\(").replaceAll(")", "\\)")

      assert.ok(
        pdf.includes(encoded),
        `${scenario.id} PDF is missing a line: ${line}`
      )
    }

    assert.ok(pdf.includes("SYNTHETIC DEMONSTRATION DOCUMENT"))
  }
})

test("no scenario names a real company or confidential source", () => {
  // The forbidden words are the names of the application company and the
  // product this demo must not resemble. They are stored base64-encoded rather
  // than as literals so that grepping the public repository for them returns
  // nothing at all — including this guard, which is the one place that would
  // otherwise reintroduce them.
  const banned = new RegExp(
    ["bWVyY3VyYQ==", "YjJwb3J0YWw="]
      .map((encoded) => Buffer.from(encoded, "base64").toString("utf8"))
      .join("|"),
    "i"
  )
  const material = JSON.stringify(SCENARIOS)

  assert.equal(banned.test(material), false)

  for (const scenario of SCENARIOS) {
    assert.match(scenario.email.from.email, /\.example$/)
    assert.match(scenario.email.to, /\.example$/)
  }
})
