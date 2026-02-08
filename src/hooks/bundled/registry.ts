/**
 * Static registry for bundled hook handlers
 *
 * Bundled hooks are statically imported so they get compiled into the main
 * bundle by tsdown. At runtime, the loader looks up handlers from this
 * registry instead of using dynamic import() — which would fail because
 * the raw .ts handler files aren't available in dist/.
 *
 * When adding a new bundled hook, import its handler here and add it to
 * the registry map.
 */

import bootMdHandler from "./boot-md/handler.js";
import commandLoggerHandler from "./command-logger/handler.js";
import sessionMemoryHandler from "./session-memory/handler.js";
import soulEvilHandler from "./soul-evil/handler.js";

/**
 * Map of hook directory name → handler module exports.
 *
 * Each value mirrors what `import(handlerPath)` would return:
 * an object with the handler as the `default` export (or a named export).
 */
export const bundledHandlerRegistry = new Map<string, Record<string, unknown>>([
  ["boot-md", { default: bootMdHandler }],
  ["command-logger", { default: commandLoggerHandler }],
  ["session-memory", { default: sessionMemoryHandler }],
  ["soul-evil", { default: soulEvilHandler }],
]);

/**
 * Look up a bundled hook handler by hook name.
 * Returns the module-like object (with default/named exports), or undefined.
 */
export function getBundledHandlerModule(hookName: string): Record<string, unknown> | undefined {
  return bundledHandlerRegistry.get(hookName);
}
