import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Keeps each connector separate. A vendor connector may import Node built-ins,
 * its own folder, and the contract module. It may not import the manifest
 * engine, another connector, or anything else in src/. The contract module
 * itself may import nothing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTORS = join(ROOT, "src", "connectors");
const CONTRACT = join(ROOT, "src", "connector-contract.ts");
const CONTRACT_IMPORT = "../../connector-contract.js";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:import|export)[^;]*?from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
}

function vendors(): string[] {
  return readdirSync(CONNECTORS).filter((name) => statSync(join(CONNECTORS, name)).isDirectory());
}

describe("connector boundaries", () => {
  it("has at least one connector to check", () => {
    expect(vendors().length).toBeGreaterThan(0);
  });

  it("the contract module imports nothing", () => {
    expect(importsOf(CONTRACT)).toEqual([]);
  });

  for (const vendor of vendors()) {
    it(`${vendor} imports only Node built-ins, its own folder, and the contract`, () => {
      const folder = join(CONNECTORS, vendor);
      const violations: string[] = [];
      for (const file of sourceFiles(folder)) {
        for (const specifier of importsOf(file)) {
          if (specifier.startsWith("node:")) continue;
          if (specifier === CONTRACT_IMPORT) continue;
          if (specifier.startsWith("./") && !specifier.startsWith("../")) {
            // A file in the same folder is allowed; a path that climbs out of it is not.
            const target = join(dirname(file), specifier);
            if (!target.startsWith(folder)) violations.push(`${relative(ROOT, file)} -> ${specifier}`);
            continue;
          }
          violations.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
