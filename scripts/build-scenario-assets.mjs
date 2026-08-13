#!/usr/bin/env node
/**
 * Renders the synthetic attachment for each curated scenario: one PDF item list
 * and one photograph-style label image, written into `public/scenarios/`.
 *
 * The files are deliberately plain. They exist so the demo has real binary
 * documents to read rather than pasted text, and both carry a visible synthetic
 * marker. Generation is deterministic: no timestamps, no randomness.
 *
 * Rebuild with `pnpm assets:build`.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { deflateSync } from "node:zlib"
import { fileURLToPath } from "node:url"

const { SCENARIOS } = await import("../worker/scenarios.ts")

const PUBLIC_DIR = fileURLToPath(
  new URL("../public/scenarios", import.meta.url)
)

/* -------------------------------------------------------------------------- */
/* PDF                                                                         */
/* -------------------------------------------------------------------------- */

function escapePdfText(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
}

/**
 * A single-page PDF in Courier. Written by hand rather than with a library so
 * the bytes stay stable and the file stays a few kilobytes.
 */
function buildPdf(lines) {
  const content = [
    "BT",
    "/F1 10 Tf",
    "13 TL",
    "56 760 Td",
    ...lines.map((line) => `(${escapePdfText(line)}) Tj T*`),
    "ET",
  ].join("\n")

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
  ]

  let pdf = "%PDF-1.4\n"
  const offsets = []

  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, "latin1")
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                         */
/* -------------------------------------------------------------------------- */

const GLYPHS = {
  A: ".###.|#...#|#...#|#####|#...#|#...#|#...#",
  B: "####.|#...#|#...#|####.|#...#|#...#|####.",
  C: ".###.|#...#|#....|#....|#....|#...#|.###.",
  D: "####.|#...#|#...#|#...#|#...#|#...#|####.",
  E: "#####|#....|#....|####.|#....|#....|#####",
  F: "#####|#....|#....|####.|#....|#....|#....",
  G: ".###.|#...#|#....|#.###|#...#|#...#|.###.",
  H: "#...#|#...#|#...#|#####|#...#|#...#|#...#",
  I: "#####|..#..|..#..|..#..|..#..|..#..|#####",
  J: "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
  K: "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
  L: "#....|#....|#....|#....|#....|#....|#####",
  M: "#...#|##.##|#.#.#|#...#|#...#|#...#|#...#",
  N: "#...#|##..#|#.#.#|#..##|#...#|#...#|#...#",
  O: ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
  P: "####.|#...#|#...#|####.|#....|#....|#....",
  Q: ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
  R: "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
  S: ".####|#....|#....|.###.|....#|....#|####.",
  T: "#####|..#..|..#..|..#..|..#..|..#..|..#..",
  U: "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
  V: "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
  W: "#...#|#...#|#...#|#...#|#.#.#|##.##|#...#",
  X: "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
  Y: "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
  Z: "#####|....#|...#.|..#..|.#...|#....|#####",
  0: ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
  1: "..#..|.##..|..#..|..#..|..#..|..#..|.###.",
  2: ".###.|#...#|....#|...#.|..#..|.#...|#####",
  3: "#####|...#.|..#..|...#.|....#|#...#|.###.",
  4: "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.",
  5: "#####|#....|####.|....#|....#|#...#|.###.",
  6: "..##.|.#...|#....|####.|#...#|#...#|.###.",
  7: "#####|....#|...#.|..#..|.#...|.#...|.#...",
  8: ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
  9: ".###.|#...#|#...#|.####|....#|...#.|.##..",
  " ": ".....|.....|.....|.....|.....|.....|.....",
  "-": ".....|.....|.....|#####|.....|.....|.....",
  "/": "....#|....#|...#.|..#..|.#...|#....|#....",
  ".": ".....|.....|.....|.....|.....|.....|..#..",
  ",": ".....|.....|.....|.....|.....|..#..|.#...",
}

const UNKNOWN_GLYPH = "#####|#...#|#...#|#...#|#...#|#...#|#####"

const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
const SCALE = 3
const CHAR_ADVANCE = (GLYPH_WIDTH + 1) * SCALE
const LINE_ADVANCE = (GLYPH_HEIGHT + 4) * SCALE
const MARGIN = 18

function crc32(buffer) {
  let crc = 0xffffffff

  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }

  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

/** An eight-bit greyscale PNG holding the label text on a paper-toned field. */
function buildPng(lines) {
  const widestLine = lines.reduce(
    (widest, line) => Math.max(widest, line.length),
    0
  )
  const width = MARGIN * 2 + widestLine * CHAR_ADVANCE
  const height = MARGIN * 2 + lines.length * LINE_ADVANCE

  const pixels = Buffer.alloc(width * height, 0xe8)

  const setPixel = (x, y, value) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    pixels[y * width + x] = value
  }

  // A photographed label has an edge; a thin frame reads as one.
  for (let x = 0; x < width; x += 1) {
    for (let inset = 0; inset < 2; inset += 1) {
      setPixel(x, 4 + inset, 0x60)
      setPixel(x, height - 5 - inset, 0x60)
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let inset = 0; inset < 2; inset += 1) {
      setPixel(4 + inset, y, 0x60)
      setPixel(width - 5 - inset, y, 0x60)
    }
  }

  lines.forEach((line, lineIndex) => {
    const top = MARGIN + lineIndex * LINE_ADVANCE

    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const glyph = GLYPHS[line[charIndex].toUpperCase()] ?? UNKNOWN_GLYPH
      const rows = glyph.split("|")
      const left = MARGIN + charIndex * CHAR_ADVANCE

      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        for (let column = 0; column < GLYPH_WIDTH; column += 1) {
          if (rows[row][column] !== "#") continue

          for (let dy = 0; dy < SCALE; dy += 1) {
            for (let dx = 0; dx < SCALE; dx += 1) {
              setPixel(left + column * SCALE + dx, top + row * SCALE + dy, 0x18)
            }
          }
        }
      }
    }
  })

  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // greyscale
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

/* -------------------------------------------------------------------------- */

/** The committed asset bytes for one scenario, rebuilt from its definition. */
export function renderScenarioAssets(scenario) {
  return {
    directory: `${PUBLIC_DIR}/${scenario.id}`,
    pdf: {
      filename: scenario.pdfAttachment.filename,
      bytes: buildPdf(scenario.pdfLines),
    },
    image: {
      filename: scenario.inlineImage.filename,
      bytes: buildPng([...scenario.imageLines, "SYNTHETIC SAMPLE"]),
    },
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  for (const scenario of SCENARIOS) {
    const assets = renderScenarioAssets(scenario)
    await mkdir(assets.directory, { recursive: true })
    await writeFile(
      `${assets.directory}/${assets.pdf.filename}`,
      assets.pdf.bytes
    )
    await writeFile(
      `${assets.directory}/${assets.image.filename}`,
      assets.image.bytes
    )

    process.stdout.write(
      `${scenario.id}: ${assets.pdf.filename} ${assets.pdf.bytes.length} B, ` +
        `${assets.image.filename} ${assets.image.bytes.length} B\n`
    )
  }
}
