# pi-cohort-mux

Mux-agnostic mechanics shared by the
[pi-cohort](https://github.com/jjuraszek/pi-cohort) multiplexer adapters: the
event queue, the launch lease, and the owner-only environment FIFO with its
`sh` bootstrap. It does not import `pi-cohort`.

Install an adapter instead, which depends on this package:
[`pi-cohort-mux-cmux`](https://www.npmjs.com/package/pi-cohort-mux-cmux) or
[`pi-cohort-mux-herdr`](https://www.npmjs.com/package/pi-cohort-mux-herdr).
See the [repository README](https://github.com/nertzy/pi-cohort-mux#readme)
for the adapter convention.
