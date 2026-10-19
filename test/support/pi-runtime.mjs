// Locate the Pi runtime the way a shell would: the first executable `pi` on
// PATH, followed through symlinks to the @earendil-works/pi-coding-agent
// package that backs it. Works for npm-global (bin symlink into the package),
// Homebrew (bin -> libexec symlink chain), and shim installs such as mise,
// whose bin is a script beside the package's node_modules.
//
// Every lookup returns either a value or a `skipReason` that names what was
// looked for, so a skipped test says exactly which prerequisite was missing.

import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";

const codingAgent = "@earendil-works/pi-coding-agent";

export function findOnPath(name, path = process.env.PATH ?? "") {
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

const packageName = (directory) => {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
};

function packageRootFrom(start) {
  for (let directory = start; ; directory = dirname(directory)) {
    if (packageName(directory) === codingAgent) return directory;
    for (const candidate of [join(directory, "node_modules", codingAgent), join(directory, codingAgent)]) {
      if (packageName(candidate) === codingAgent) return realpathSync(candidate);
    }
    if (directory === parse(directory).root) return null;
  }
}

export function resolvePi(path = process.env.PATH ?? "") {
  const executable = findOnPath("pi", path);
  if (!executable) return { skipReason: "requires an executable `pi` on PATH" };
  const root = packageRootFrom(dirname(realpathSync(executable)));
  if (!root) return { executable, skipReason: `requires ${codingAgent} next to ${realpathSync(executable)} (resolved from \`pi\` on PATH)` };
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return { executable, root, version };
}

// The file URL of a dist module inside the resolved pi-coding-agent package.
export function piModule(pi, relativePath) {
  if (pi.skipReason) return { skipReason: pi.skipReason };
  const file = join(pi.root, relativePath);
  return existsSync(file) ? { url: pathToFileURL(file).href } : { skipReason: `requires ${file} in Pi ${pi.version}` };
}

// The ESM entry URL of a package Pi itself depends on (e.g. @earendil-works/pi-ai),
// resolved with Node's lookup paths from the pi-coding-agent package root.
export function piDependency(pi, name) {
  if (pi.skipReason) return { skipReason: pi.skipReason };
  const lookup = createRequire(join(pi.root, "package.json")).resolve.paths(name) ?? [];
  const directory = lookup.map((base) => join(base, name)).find((candidate) => packageName(candidate) === name);
  if (!directory) return { skipReason: `requires ${name} resolvable from ${pi.root}` };
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const root = manifest.exports?.["."] ?? manifest.exports;
  const entry = (typeof root === "string" ? root : root?.import?.default ?? root?.import ?? root?.default) ?? manifest.module ?? manifest.main;
  return { url: pathToFileURL(join(directory, entry)).href };
}
