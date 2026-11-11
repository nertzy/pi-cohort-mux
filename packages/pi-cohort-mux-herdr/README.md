# pi-cohort-mux-herdr

A [herdr](https://github.com/herdrdev/herdr) execution adapter for
[pi-cohort](https://github.com/jjuraszek/pi-cohort). Inside a herdr pane, each
`subagent` child runs in its own background tab (or a split, with
`PI_COHORT_MUX_HERDR_PLACEMENT=split`), and herdr removes it when the child
exits.

```sh
pi install npm:pi-cohort
pi install npm:pi-cohort-mux-herdr
```

Needs `pi-cohort` 7.x and Node.js 26 or newer. Outside herdr the adapter
reports itself unavailable, so `pi-cohort` falls back to its native backend.
See the [repository README](https://github.com/nertzy/pi-cohort-mux#readme)
for placement and backend selection.
