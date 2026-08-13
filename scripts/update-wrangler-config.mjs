import fs from "node:fs"
import path from "node:path"
import { parse, printParseErrorCode } from "jsonc-parser"

const [configPath, slug, d1Id] = process.argv.slice(2)

if (!configPath || !slug || !d1Id) {
  throw new Error(
    "Usage: node scripts/update-wrangler-config.mjs <config-path> <slug> <d1-id>"
  )
}

const source = fs.readFileSync(configPath, "utf8")
const parseErrors = []
const config = parse(source, parseErrors, {
  allowTrailingComma: true,
  disallowComments: false,
})

if (parseErrors.length > 0) {
  const details = parseErrors
    .map(
      ({ error, offset }) =>
        `${printParseErrorCode(error)} at character ${offset}`
    )
    .join(", ")
  throw new Error(`Unable to parse ${configPath} as JSONC: ${details}`)
}

if (!config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error(`${configPath} must contain a JSON object`)
}

const binding = (collectionName, bindingName) => {
  const collection = config[collectionName]
  const entry = Array.isArray(collection)
    ? collection.find((candidate) => candidate?.binding === bindingName)
    : undefined

  if (!entry) {
    throw new Error(
      `${configPath} is missing the ${bindingName} binding in ${collectionName}`
    )
  }

  return entry
}

const database = binding("d1_databases", "DB")
const artifactBucket = binding("r2_buckets", "ARTIFACTS")
const workflow = binding("workflows", "RFQ_WORKFLOW")

if (!config.vars || typeof config.vars !== "object") {
  throw new Error(`${configPath} is missing its vars object`)
}

config.name = slug
database.database_name = `${slug}-db`
database.database_id = d1Id
artifactBucket.bucket_name = `${slug}-artifacts`
workflow.name = `${slug}-workflow`
config.vars.APP_ENV = "production"

const temporaryPath = path.join(
  path.dirname(configPath),
  `.${path.basename(configPath)}.${process.pid}.tmp`
)

try {
  fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`)
  fs.renameSync(temporaryPath, configPath)
} finally {
  if (fs.existsSync(temporaryPath)) {
    fs.unlinkSync(temporaryPath)
  }
}
