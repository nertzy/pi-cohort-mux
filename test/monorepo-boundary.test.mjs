import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { piModule, resolvePi } from "./support/pi-runtime.mjs";

const exec = promisify(execFile);
const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
const core = JSON.parse(await readFile(new URL("../packages/pi-cohort-mux/package.json", import.meta.url)));
const adapter = JSON.parse(await readFile(new URL("../packages/pi-cohort-mux-cmux/package.json", import.meta.url)));
const piLoader = piModule(resolvePi(), "dist/core/extensions/index.js");

test("root is a private workspace and only the adapter activates in Pi", () => {
  assert.equal(root.private, true);
  assert.equal(core.private, true);
  assert.equal(adapter.private, true);
  assert.deepEqual(root.workspaces, ["packages/*"]);
  assert.equal(root.pi, undefined);
  assert.equal(core.pi, undefined);
  assert.deepEqual(adapter.pi.extensions, ["./src/index.js"]);
  assert.equal(adapter.dependencies["pi-cohort-mux"], core.version);
  assert.match(adapter.dependencies["pi-cohort"], /^\^6\.1\.0/);
});

test("adapter reload factory is a public package export", async () => {
  const module = await import("pi-cohort-mux-cmux/execution-backend");
  assert.equal(typeof module.createCmuxExecutionBackend, "function");
  assert.equal(module.createCmuxExecutionBackend().name, "cmux");
});

test("packed adapter alone installs core transitively and activates through Pi", { skip: piLoader.skipReason ?? false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cohort-mux-consumer-"));
  let registry;
  try {
    const pack = async (packagePath) => {
      const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", directory, packagePath], { cwd: new URL("..", import.meta.url) });
      const result = JSON.parse(stdout);
      return join(directory, (Array.isArray(result) ? result[0] : Object.values(result)[0]).filename);
    };
    const corePack = await pack("./packages/pi-cohort-mux");
    const adapterPack = await pack("./packages/pi-cohort-mux-cmux");
    const coreArchive = await readFile(corePack);
    registry = createServer(async (request, response) => {
      if (request.url === "/pi-cohort-mux") {
        const origin = `http://127.0.0.1:${registry.address().port}`;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          name: core.name,
          versions: { [core.version]: { ...core, dist: { tarball: `${origin}/pi-cohort-mux/-/pi-cohort-mux-${core.version}.tgz` } } },
          "dist-tags": { latest: core.version },
        }));
        return;
      }
      if (request.url === `/pi-cohort-mux/-/pi-cohort-mux-${core.version}.tgz`) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(coreArchive);
        return;
      }
      const upstream = await fetch(new URL(request.url, "https://registry.npmjs.org"), {
        headers: { accept: request.headers.accept ?? "application/json" },
      });
      response.statusCode = upstream.status;
      response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/octet-stream");
      response.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));

    await exec("npm", ["init", "-y"], { cwd: directory });
    const registryUrl = `http://127.0.0.1:${registry.address().port}`;
    await exec("npm", ["install", "--registry", registryUrl, adapterPack], { cwd: directory });
    const consumerManifest = JSON.parse(await readFile(join(directory, "package.json")));
    assert.deepEqual(Object.keys(consumerManifest.dependencies), ["pi-cohort-mux-cmux"]);
    const installed = JSON.parse(await readFile(join(directory, "node_modules/pi-cohort-mux/package.json")));
    assert.equal(installed.name, "pi-cohort-mux");

    const { loadExtensions } = await import(piLoader.url);
    const adapterEntry = join(directory, "node_modules/pi-cohort-mux-cmux/src/index.js");
    const loaded = await loadExtensions([adapterEntry], directory);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const hub = globalThis[Symbol.for("pi-cohort.execution-backends.v1")];
    assert.equal(hub.backends.get("cmux")?.name, "cmux");
    assert.deepEqual(Object.keys(hub.reloadDescriptors.get("cmux")).sort(), [
      "factoryExport", "packageJsonUrl", "protocolVersion", "publicSubpath",
    ]);
  } finally {
    if (registry) await new Promise(resolve => registry.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
