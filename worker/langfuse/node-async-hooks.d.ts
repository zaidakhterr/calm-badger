/**
 * The one Node builtin the Worker uses, typed by hand.
 *
 * Workers provide `node:async_hooks` under the `nodejs_compat` flag, but the
 * generated Worker types do not declare it, and pulling all of `@types/node`
 * into a WebWorker program brings conflicting globals with it. This is the
 * slice the context manager calls.
 */
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined
    run<R>(store: T, callback: () => R): R
    disable(): void
  }
}
