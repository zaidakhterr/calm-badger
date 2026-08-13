/**
 * Secret bindings.
 *
 * `wrangler types` generates the variables declared in `wrangler.jsonc` but not
 * the encrypted secrets, so they are declared here. The values are read only
 * where they are used to authenticate a provider call; they are never logged,
 * persisted, or returned in a response.
 */

declare global {
  interface Env {
    /** Mistral API key. Uploaded with `wrangler secret put MISTRAL_API_KEY`. */
    MISTRAL_API_KEY?: string
    /** OpenRouter API key. Uploaded with `wrangler secret put OPENROUTER_API_KEY`. */
    OPENROUTER_API_KEY?: string
  }
}

export {}
