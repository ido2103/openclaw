import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function hasBundledHooks(dir: string): boolean {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return false;
    }
    // Check for at least one subdirectory containing a HOOK.md.
    // Handler files are not required on disk because bundled hook handlers
    // are statically compiled into the main bundle (see bundled/registry.ts).
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "HOOK.md")));
  } catch {
    return false;
  }
}

export function resolveBundledHooksDir(
  here = path.dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_HOOKS_DIR?.trim();
  if (override) {
    return override;
  }

  // bun --compile: ship a sibling `hooks/bundled/` next to the executable.
  try {
    const execDir = path.dirname(process.execPath);
    const sibling = path.join(execDir, "hooks", "bundled");
    if (hasBundledHooks(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // Walk up from the module directory looking for bundled hooks.
  // Works in all layouts: source, transpiled (dist/hooks/), and bundled (dist/).
  try {
    let current = here;
    for (let i = 0; i < 5; i++) {
      // Check both src/ and dist/ relative to current directory
      for (const sub of ["src/hooks/bundled", "hooks/bundled", "dist/hooks/bundled"]) {
        const candidate = path.join(current, sub);
        if (hasBundledHooks(candidate)) {
          return candidate;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}
