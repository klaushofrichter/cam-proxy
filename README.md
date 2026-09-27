# cam-proxy

A gateway next to a Reolink camera (RLC-1224A). It is the camera's only
client, stores what matters (stills every second, events, clips), and offers
a clean API with a live, resumable SSE event stream, so apps such as
[cams](https://github.com/klaushofrichter/cams) don't depend on the camera's
quirks.

**Status:** requirements only; see [docs/requirements.md](docs/requirements.md).
Development uses [cam-sim](https://github.com/klaushofrichter/cam-sim), a
simulated camera, and the real camera for verification.

Targets: a Raspberry Pi 4 next to the real camera, and the k3s cluster next to
`cam2` (cam-sim), both production. A Mac runs it for development.

MIT licence.
