import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { piModule, resolvePi } from "./support/pi-runtime.mjs";

const exec = promisify(execFile);
const root = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);
const core = JSON.parse(
  await readFile(
    new URL("../packages/pi-cohort-mux/package.json", import.meta.url),
  ),
);
const adapters = await Promise.all(
  ["cmux", "herdr"].map(async (backend) => ({
    backend,
    directory: `./packages/pi-cohort-mux-${backend}`,
    manifest: JSON.parse(
      await readFile(
        new URL(
          `../packages/pi-cohort-mux-${backend}/package.json`,
          import.meta.url,
        ),
      ),
    ),
  })),
);
const piLoader = piModule(resolvePi(), "dist/core/extensions/index.js");

test("root is a private workspace and only the adapters activate in Pi", () => {
  assert.equal(root.private, true);
  assert.equal(core.private, true);
  assert.deepEqual(root.workspaces, ["packages/*"]);
  assert.equal(root.pi, undefined);
  assert.equal(core.pi, undefined);
  for (const { manifest: adapter } of adapters) {
    assert.equal(adapter.private, true);
    assert.deepEqual(adapter.pi.extensions, ["./src/index.js"]);
    assert.equal(adapter.dependencies["pi-cohort-mux"], core.version);
    assert.equal(
      adapter.dependencies["pi-cohort"],
      undefined,
      "the host's pi-cohort is shared, never a private copy",
    );
    assert.equal(adapter.peerDependencies["pi-cohort"], "^7.0.0");
    assert.equal(
      adapter.peerDependencies["@earendil-works/pi-coding-agent"],
      ">=0.85.0",
    );
  }
});

test("adapter reload factories are public package exports", async () => {
  const cmux = await import("pi-cohort-mux-cmux/execution-backend");
  assert.equal(cmux.createCmuxExecutionBackend().name, "cmux");
  await assertReloadNamesItself(
    "pi-cohort-mux-cmux",
    cmux,
    cmux.createCmuxExecutionBackend(),
  );
  const herdr = await import("pi-cohort-mux-herdr/execution-backend");
  assert.equal(herdr.createHerdrExecutionBackend().name, "herdr");
  await assertReloadNamesItself(
    "pi-cohort-mux-herdr",
    herdr,
    herdr.createHerdrExecutionBackend(),
  );
});

// A backend carries the descriptor pi-cohort uses to recreate it in another
// process; it must name its own package, public subpath, and factory.
async function assertReloadNamesItself(packageName, module, backend) {
  const { reload } = backend;
  assert.equal(reload.protocolVersion, 1);
  const manifest = JSON.parse(await readFile(new URL(reload.packageJsonUrl)));
  assert.equal(manifest.name, packageName);
  assert.equal(reload.publicSubpath, "./execution-backend");
  assert.equal(
    await import(`${packageName}/execution-backend`),
    module,
    "the descriptor's subpath is the module that built the backend",
  );
  assert.equal(module[reload.factoryExport]().name, backend.name);
}

for (const { backend, directory: adapterDirectory, manifest } of adapters)
  test(
    `packed ${backend} adapter alone installs core transitively and activates through Pi`,
    {
      skip: piLoader.skipReason ?? false,
    },
    () => packedAdapterActivates(backend, adapterDirectory, manifest),
  );

async function packedAdapterActivates(backend, adapterDirectory, adapter) {
  const directory = await mkdtemp(join(tmpdir(), "pi-cohort-mux-consumer-"));
  let registry;
  try {
    const pack = async (packagePath) => {
      const { stdout } = await exec(
        "npm",
        ["pack", "--json", "--pack-destination", directory, packagePath],
        { cwd: new URL("..", import.meta.url) },
      );
      const result = JSON.parse(stdout);
      return join(
        directory,
        (Array.isArray(result) ? result[0] : Object.values(result)[0]).filename,
      );
    };
    const corePack = await pack("./packages/pi-cohort-mux");
    const adapterPack = await pack(adapterDirectory);
    const coreArchive = await readFile(corePack);
    registry = createServer(async (request, response) => {
      if (request.url === "/pi-cohort-mux") {
        const origin = `http://127.0.0.1:${registry.address().port}`;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: core.name,
            versions: {
              [core.version]: {
                ...core,
                dist: {
                  tarball: `${origin}/pi-cohort-mux/-/pi-cohort-mux-${core.version}.tgz`,
                },
              },
            },
            "dist-tags": { latest: core.version },
          }),
        );
        return;
      }
      if (
        request.url === `/pi-cohort-mux/-/pi-cohort-mux-${core.version}.tgz`
      ) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(coreArchive);
        return;
      }
      const upstream = await fetch(
        new URL(request.url, "https://registry.npmjs.org"),
        {
          headers: { accept: request.headers.accept ?? "application/json" },
        },
      );
      response.statusCode = upstream.status;
      response.setHeader(
        "content-type",
        upstream.headers.get("content-type") ?? "application/octet-stream",
      );
      response.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));

    await exec("npm", ["init", "-y"], { cwd: directory });
    const registryUrl = `http://127.0.0.1:${registry.address().port}`;
    await exec("npm", ["install", "--registry", registryUrl, adapterPack], {
      cwd: directory,
    });
    const consumerManifest = JSON.parse(
      await readFile(join(directory, "package.json")),
    );
    assert.deepEqual(Object.keys(consumerManifest.dependencies), [
      adapter.name,
    ]);
    const installed = JSON.parse(
      await readFile(
        join(directory, "node_modules/pi-cohort-mux/package.json"),
      ),
    );
    assert.equal(installed.name, "pi-cohort-mux");

    const { loadExtensions } = await import(piLoader.url);
    const adapterEntry = join(
      directory,
      `node_modules/${adapter.name}/src/index.js`,
    );
    const loaded = await loadExtensions([adapterEntry], directory);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const hub = globalThis[Symbol.for("pi-cohort.execution-backends.v1")];
    assert.equal(hub.backends.get(backend)?.name, backend);
    assert.deepEqual(Object.keys(hub.reloadDescriptors.get(backend)).sort(), [
      "factoryExport",
      "packageJsonUrl",
      "protocolVersion",
      "publicSubpath",
    ]);
  } finally {
    if (registry) await new Promise((resolve) => registry.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
