import assert from "node:assert/strict";
import { test } from "node:test";

import { Text, visibleWidth } from "@earendil-works/pi-tui";

import {
  badgeSubagentRenderers,
  ranInPane,
  subagentBadgeResolver,
} from "../packages/pi-cohort-mux-cmux/src/tool-color.js";

const ACCENT = (text) => `\x1b[36m${text}\x1b[39m`;
const theme = {
  fg: (token, text) => (token === "accent" ? ACCENT(text) : text),
  bold: (text) => text,
};

const surface = (backend) => ({ executionSurface: { handle: { backend } } });
const details = (...backends) => ({ results: backends.map(surface) });
const cmuxResult = { content: [], details: details("cmux") };
const nativeResult = { content: [], details: details("native") };
const partialResult = { content: [], details: { results: [{}] } };

function fakeBase() {
  const calls = [];
  const resultComponent = new Text("result", 0, 0);
  return {
    calls,
    resultComponent,
    renderCall(args, _theme, context) {
      calls.push(context.lastComponent);
      return new Text(`subagent ${args.agent}`, 0, 0);
    },
    renderResult: () => resultComponent,
  };
}

// Pi rebuilds a row on every update: call first, then result, then draws.
function renderRow(
  renderers,
  { result, isError = false, isPartial = false, width = 40, context },
) {
  const ctx = context ?? { state: {}, lastComponent: undefined, isError };
  ctx.isError = isError;
  const call = renderers.renderCall({ agent: "delegate" }, theme, ctx);
  if (result) {
    renderers.renderResult(result, { expanded: false, isPartial }, theme, ctx);
  }
  return { call, lines: call.render(width), ctx };
}

const pad = (text, width) => text + " ".repeat(width - visibleWidth(text));

test("ranInPane reads the cmux backend from any result's execution surface", () => {
  assert.equal(ranInPane(details("cmux")), true);
  assert.equal(ranInPane(details("native", "cmux")), true);
  assert.equal(ranInPane(details("native")), false);
  assert.equal(ranInPane({ results: [{}] }), false);
  assert.equal(ranInPane(undefined), false);
});

test("a finished cmux run adds an accent [cmux] badge to the call line", () => {
  const { lines } = renderRow(badgeSubagentRenderers(fakeBase()), {
    result: cmuxResult,
  });
  assert.deepEqual(lines, [pad(`subagent delegate ${ACCENT("[cmux]")}`, 40)]);
});

test("a native run, a call with no result yet, and an in-progress update get no badge", () => {
  const renderers = badgeSubagentRenderers(fakeBase());
  const plain = [pad("subagent delegate", 40)];
  assert.deepEqual(renderRow(renderers, { result: nativeResult }).lines, plain);
  assert.deepEqual(renderRow(renderers, {}).lines, plain);
  assert.deepEqual(
    renderRow(renderers, { result: partialResult, isPartial: true }).lines,
    plain,
  );
});

test("a failed run that ran in cmux still says where it ran", () => {
  const { lines } = renderRow(badgeSubagentRenderers(fakeBase()), {
    result: cmuxResult,
    isError: true,
  });
  assert.deepEqual(lines, [pad(`subagent delegate ${ACCENT("[cmux]")}`, 40)]);
});

test("the badge never widens the line past the available width", () => {
  const { lines } = renderRow(badgeSubagentRenderers(fakeBase()), {
    result: cmuxResult,
    width: 20,
  });
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0]) <= 20, JSON.stringify(lines[0]));
});

test("the result renderer and Pi's frame are left alone", () => {
  const base = fakeBase();
  const renderers = badgeSubagentRenderers(base);
  assert.equal(renderers.renderShell, undefined);
  const ctx = { state: {}, lastComponent: undefined, isError: false };
  const component = renderers.renderResult(
    cmuxResult,
    { expanded: false, isPartial: false },
    theme,
    ctx,
  );
  assert.equal(component, base.resultComponent);
});

test("pi-cohort's call renderer gets back its own previous component", () => {
  const base = fakeBase();
  const renderers = badgeSubagentRenderers(base);
  const first = renderRow(renderers, { result: cmuxResult });
  first.ctx.lastComponent = first.call;
  renderRow(renderers, { result: cmuxResult, context: first.ctx });
  assert.equal(base.calls[0], undefined);
  assert.ok(base.calls[1] instanceof Text);
  assert.notEqual(base.calls[1], first.call);
});

test("invalidate reaches pi-cohort's component", () => {
  const { call } = renderRow(badgeSubagentRenderers(fakeBase()), {
    result: cmuxResult,
  });
  let invalidated = false;
  call.inner.invalidate = () => {
    invalidated = true;
  };
  call.invalidate();
  assert.equal(invalidated, true);
});

test("the resolver badges only subagent, and only when there is a renderer to wrap", () => {
  const base = fakeBase();
  const wrapped = subagentBadgeResolver("subagent", () => base);
  assert.notEqual(wrapped, base);
  assert.equal(typeof wrapped.renderCall, "function");
  const other = { renderCall() {} };
  assert.equal(
    subagentBadgeResolver("bash", () => other),
    other,
  );
  assert.equal(
    subagentBadgeResolver("subagent", () => undefined),
    undefined,
  );
  const callOnly = { renderCall: base.renderCall };
  assert.equal(
    subagentBadgeResolver("subagent", () => callOnly),
    callOnly,
  );
});
