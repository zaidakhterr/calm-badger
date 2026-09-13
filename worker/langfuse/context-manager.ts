/**
 * An OpenTelemetry context manager for the Workers runtime.
 *
 * The OpenTelemetry API needs a context manager to carry the active span across
 * `await` boundaries. Its own `AsyncLocalStorageContextManager` is a Node
 * package that requires the bare `async_hooks` and `events` builtins, which
 * the Workers module loader and Vite's optimizer both refuse. Workers provide
 * `AsyncLocalStorage` under the `nodejs_compat` flag, so this is the same
 * manager written against `node:async_hooks` directly.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { ROOT_CONTEXT } from "@opentelemetry/api"
import type { Context, ContextManager } from "@opentelemetry/api"

export class AsyncLocalStorageContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>()

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(context, () => fn.apply(thisArg, args))
  }

  /**
   * Binding a callback to a context is not supported. Nothing in this Worker
   * calls it: the AI SDK and the Langfuse SDK carry context with `with`. The
   * target is returned unchanged, so a caller that did bind would run its
   * callback in whichever context is active when it fires.
   */
  bind<T>(_context: Context, target: T): T {
    return target
  }

  enable(): this {
    return this
  }

  disable(): this {
    this.storage.disable()
    return this
  }
}
