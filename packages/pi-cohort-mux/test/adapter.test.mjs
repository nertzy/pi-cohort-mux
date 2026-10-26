import assert from "node:assert/strict";
import { test } from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installMuxAdapter } = await jiti.import("pi-cohort-mux/adapter");
const { selectExecutionBackend, EXECUTION_BACKEND_PROTOCOL_VERSION } =
  await jiti.import("pi-cohort/execution-backend");
const { default: installFakeAdapter } = await jiti.import(
  "./fixtures/fake-adapter/src/index.js",
);

const fixture = (path) => new URL(`fixtures/${path}`, import.meta.url);
const hub = () => globalThis[Symbol.for("pi-cohort.execution-backends.v1")];

const ACCENT = (text) => `<${text}>`;
const theme = { fg: (_token, text) => ACCENT(text), bold: (text) => text };

function fakeBackend(name) {
  return {
    name,
    protocolVersion: 1,
    detect: async () => ({ available: true }),
    launch: async () => {
      throw new Error("not launched in this test");
    },
    reattach: async () => ({ status: "gone" }),
    close: async () => {},
  };
}

function fakePi() {
  const resolvers = [];
  return { resolvers, registerToolRenderer: (r) => resolvers.push(r) };
}

function badgeFrom(resolver, backend) {
  const base = {
    renderCall: () => ({ render: () => ["subagent delegate"] }),
    renderResult: () => ({ render: () => [] }),
  };
  const renderers = resolver("subagent", () => base);
  const context = { state: {} };
  const call = renderers.renderCall({}, theme, context);
  renderers.renderResult(
    {
      content: [],
      details: { results: [{ executionSurface: { handle: { backend } } }] },
    },
    {},
    theme,
    context,
  );
  return call.render(80)[0].trimEnd();
}

test("installs an adapter from its own module URL and badges calls with the backend's name", async () => {
  const pi = fakePi();
  const dispose = installFakeAdapter(pi);
  try {
    const { selection } = await selectExecutionBackend("fakemux");
    assert.equal(selection.backend.name, "fakemux");
    assert.equal(pi.resolvers.length, 1);
    assert.equal(
      badgeFrom(pi.resolvers[0], "fakemux"),
      `subagent delegate ${ACCENT("[fakemux]")}`,
    );
    assert.equal(badgeFrom(pi.resolvers[0], "native"), "subagent delegate");
  } finally {
    dispose();
  }
  await assert.rejects(
    selectExecutionBackend("fakemux"),
    /Execution backend 'fakemux' is not registered/,
  );
});

test("derives pi-cohort's reload descriptor from the adapter's package by convention", () => {
  const dispose = installFakeAdapter(fakePi());
  try {
    assert.deepEqual(hub().reloadDescriptors.get("fakemux"), {
      protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
      packageJsonUrl: fixture("fake-adapter/package.json").href,
      publicSubpath: "./execution-backend",
      factoryExport: "default",
    });
  } finally {
    dispose();
  }
});

test("registers the backend when the host has no tool renderers", async () => {
  const dispose = installFakeAdapter(undefined);
  try {
    const { selection } = await selectExecutionBackend("fakemux");
    assert.equal(selection.backend.name, "fakemux");
  } finally {
    dispose();
  }
});

test("rejects a package without an ./execution-backend export and adds no badge", () => {
  const pi = fakePi();
  assert.throws(
    () =>
      installMuxAdapter(
        pi,
        fixture("no-backend-export/src/index.js").href,
        () => fakeBackend("noexport"),
      ),
    /export_not_public/,
  );
  assert.equal(pi.resolvers.length, 0, "no badge for a rejected backend");
  assert.equal(hub().backends.has("noexport"), false);
});

test("rejects a module URL with no package.json above it", () => {
  assert.throws(
    () =>
      installMuxAdapter(fakePi(), "file:///nonexistent/src/index.js", () =>
        fakeBackend("orphan"),
      ),
    /no package\.json above file:\/\/\/nonexistent\/src\/index\.js/,
  );
});
