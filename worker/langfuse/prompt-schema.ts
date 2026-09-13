import { z } from "zod"

/** Only these structural keywords establish a required path. Unsupported compositions fail closed. */
const NODE = z.object({
  type: z.string().optional(),
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.json()).optional(),
  items: z.json().optional(),
})

/** Descend through every required object field and every array item, not just root keys. */
export function retainsRequiredFields(
  candidate: z.infer<ReturnType<typeof z.json>>,
  contract: z.infer<ReturnType<typeof z.json>>
): boolean {
  const expected = NODE.safeParse(contract)
  if (!expected.success) return false
  const fields = expected.data.required ?? []
  if (fields.length === 0 && expected.data.type !== "array") return true
  const actual = NODE.safeParse(candidate)
  if (!actual.success || actual.data.type !== expected.data.type) return false
  if (expected.data.type === "array") {
    return (
      actual.data.items !== undefined &&
      expected.data.items !== undefined &&
      retainsRequiredFields(actual.data.items, expected.data.items)
    )
  }
  return fields.every((field) => {
    const provided = actual.data.properties?.[field]
    const required = expected.data.properties?.[field]
    return (
      actual.data.required?.includes(field) &&
      provided !== undefined &&
      required !== undefined &&
      retainsRequiredFields(provided, required)
    )
  })
}

const JSON_OBJECT = z.record(z.string(), z.json())
const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "title",
  "description",
  "examples",
  "$comment",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "anyOf",
  "oneOf",
  "allOf",
])

/** Zod currently ignores some JSON Schema constraints. Refuse these instead of weakening a promise. */
export function supportedPromptSchema(
  value: z.infer<ReturnType<typeof z.json>>
): boolean {
  const boolean = z.boolean().safeParse(value)
  if (boolean.success) return true
  const parsed = JSON_OBJECT.safeParse(value)
  if (!parsed.success) return false
  for (const [keyword, child] of Object.entries(parsed.data)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) return false
    if (keyword === "properties") {
      const properties = JSON_OBJECT.safeParse(child)
      if (
        !properties.success ||
        !Object.values(properties.data).every(supportedPromptSchema)
      )
        return false
    }
    if (keyword === "items" || keyword === "additionalProperties") {
      if (!supportedPromptSchema(child)) return false
    }
    if (["anyOf", "oneOf", "allOf"].includes(keyword)) {
      const branches = z.array(z.json()).safeParse(child)
      if (!branches.success || !branches.data.every(supportedPromptSchema))
        return false
    }
  }
  return true
}
