import { truncateToWidth } from "@earendil-works/pi-tui";

// Marks a subagent call that ran in a cmux surface with an accent `[cmux]`
// badge beside pi-cohort's own `[async]` badge. Pi's frame and its pending,
// success, and error colors stay as they are.

const ROW = Symbol.for("pi-cohort-mux.tool-badge.row");

export const ranInPane = (details) =>
  Array.isArray(details?.results) &&
  details.results.some(
    (result) => result?.executionSurface?.handle?.backend === "cmux",
  );

function rowOf(context) {
  context.state[ROW] ??= {};
  return context.state[ROW];
}

// pi-cohort's call line is padded to the full width; the badge goes after
// its text, not after the padding.
function withBadge(line, badge, width) {
  return truncateToWidth(
    `${line.replace(/ +$/, "")} ${badge}`,
    width,
    "…",
    true,
  );
}

// Pi rebuilds a row by calling renderCall and then renderResult, and draws
// it afterward, so the call line reads the row's state when it is drawn.
class BadgedCall {
  constructor(inner, row, badge) {
    this.inner = inner;
    this.row = row;
    this.badge = badge;
  }

  render(width) {
    const lines = this.inner.render(width);
    if (!this.row.inPane || lines.length === 0) return lines;
    return [withBadge(lines[0], this.badge, width), ...lines.slice(1)];
  }

  invalidate() {
    this.inner.invalidate?.();
  }

  handleMouse(...args) {
    return this.inner.handleMouse?.(...args);
  }
}

export function badgeSubagentRenderers(base) {
  if (!base?.renderCall || !base.renderResult) return base;
  return {
    ...base,
    renderCall(args, theme, context) {
      const row = rowOf(context);
      const inner = base.renderCall(args, theme, {
        ...context,
        lastComponent: context.lastComponent?.inner,
      });
      return new BadgedCall(inner, row, theme.fg("accent", "[cmux]"));
    },
    renderResult(result, options, theme, context) {
      rowOf(context).inPane = ranInPane(result.details);
      return base.renderResult(result, options, theme, context);
    },
  };
}

export const subagentBadgeResolver = (toolName, next) =>
  toolName === "subagent" ? badgeSubagentRenderers(next()) : next();
