import assert from "node:assert/strict";
import { test } from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installMuxAdapter } = await jiti.import("pi-cohort-mux/adapter");
const { selectExecutionBackend } = await jiti.import(
  "pi-cohort/execution-backend",
);

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

test("installs the backend and badges subagent calls with the backend's own name", async () => {
  const pi = fakePi();
  const dispose = installMuxAdapter(pi, fakeBackend("fakemux"));
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

test("registers the backend when the host has no tool renderers", async () => {
  const dispose = installMuxAdapter(undefined, fakeBackend("bare"));
  try {
    const { selection } = await selectExecutionBackend("bare");
    assert.equal(selection.backend.name, "bare");
  } finally {
    dispose();
  }
});

test("passes the backend's own reload descriptor to pi-cohort and badges only an accepted backend", () => {
  const pi = fakePi();
  const backend = {
    ...fakeBackend("reloadable"),
    reload: {
      protocolVersion: 99,
      packageJsonUrl: new URL("../package.json", import.meta.url).href,
      publicSubpath: "./execution-backend",
      factoryExport: "createFakeExecutionBackend",
    },
  };
  assert.throws(() => installMuxAdapter(pi, backend), /reload/i);
  assert.equal(pi.resolvers.length, 0, "no badge for a rejected backend");
});
