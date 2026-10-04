# WS-Discovery samples

`reolink-probe-match.xml` is a **documented sample, not a capture**: no
Probe-match of the real camera (cam1, RLC-1224A) has been recorded yet, and
probing it was out of scope for the change that added Find camera (spec
2026-10-04-pi-config-design §3). It follows the ONVIF Core / WS-Discovery 1.0
ProbeMatches layout (gSOAP envelope, `tdn:NetworkVideoTransmitter`, scopes
`onvif://www.onvif.org/name/…` and `/hardware/…`, the device service on the
ONVIF port 8000) as Reolink cameras are reported to send it. The address,
UUIDs and serial-like parts are made up. `{{RELATES_TO}}` is replaced by the
test with the Probe's MessageID.

Replace it with a real capture (read-only: a Probe on the LAN, no login) when
one is taken at home.
