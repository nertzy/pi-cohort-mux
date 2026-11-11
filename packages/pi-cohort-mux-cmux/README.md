# pi-cohort-mux-cmux

A [cmux](https://github.com/manaflow-ai/cmux) execution adapter for
[pi-cohort](https://github.com/jjuraszek/pi-cohort). Inside a cmux terminal,
each `subagent` child runs in its own background tab in a helper pane of the
caller's workspace, and its tab closes when the child exits.

```sh
pi install npm:pi-cohort
pi install npm:pi-cohort-mux-cmux
```

Needs `pi-cohort` 7.x and Node.js 26 or newer. Outside cmux the adapter
reports itself unavailable, so `pi-cohort` falls back to its native backend.
See the [repository README](https://github.com/nertzy/pi-cohort-mux#readme)
for placement and backend selection.
