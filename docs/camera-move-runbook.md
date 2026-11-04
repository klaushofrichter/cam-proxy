# Runbook: moving a camera to another proxy

The steps in order, for an operator. How a move works, the refusal reasons
and the audit records are in [camera-move.md](camera-move.md). Addresses here
are examples (192.0.2.x for the LAN, 198.51.100.x for a camera network behind
a host).

## 1. Before you start (target proxy)

1. **Capacity.** The target's profile must allow one more camera:
   `profile.cameras` on its Settings page, or `PUT /control/profile`
   `{"cameras": N}`. Check what the host can take (CPU, memory, disk) and raise
   it by one.
2. **FTP ports.** With FTP on, the passive range needs 10 ports per camera
   (`cameras` 4 → `30000-30039`). If `ftp.passive` was set by hand, widen it
   (`PUT /control/config` `{"ftp":{"passive":"30000-30039"}}`), then restart
   the proxy: the change waits for a restart.
3. **Firewall.** Open the wider range for every camera that uploads to the
   target, in the same change. The profile lists the lines
   (`profile.firewall`, also in cams-admin's move dialog). Run the line for the
   moving camera too, at the address it has now. Widen the firewall **before**
   the proxy starts using the new range: a passive port the firewall drops
   makes the camera's upload (and `camera-ftp-test`) hang until it times out.
4. **Site CA.** The target's CA must cover the camera's address, now and after
   any re-cabling (`tls.cameraSubnet`, one CIDR, /16 or narrower). Widening it
   means a CA rotation: [the README](../README.md#tls-the-site-ca). After a
   rotation, set the viewers' pins from the proxy's report (cams-admin:
   **Use the reported pins**) instead of typing a fingerprint.
5. **Allow entries.** `move.send` on the source, `move.receive` on the target.
6. **Precheck.** cams-admin's move dialog (or `GET /api/v1/diag/moves/precheck`)
   must pass every rule: capacity, FTP ports, CA, target online, not busy.

## 2. Start the move

1. Start it in cams-admin (Moves) or on the source's Settings page, **while the
   camera is still connected where it is now**.
2. Press **Start move** once. The page shows "Move requested"; the button may
   stay enabled. A second click is refused by the server (`busy`) and starts
   nothing.
3. The **switch-over** comes first: within seconds to minutes the target serves
   the camera (live, stills, FTP point at the target). Check the target's
   health: the camera online, its live stream up, FTP on.
4. Then **copying**: the target pulls the old content from the source, newest
   first. This needs the source proxy, not the camera.

## 3. Moving the camera physically (optional)

Only after the switch-over (step 2.3). The source no longer needs the camera.

1. **Network first, then power.** A camera with Wi-Fi as well as Ethernet joins
   its Wi-Fi when it powers up without a cable, briefly with another MAC and
   address. Plug the network cable in first, then the power (PoE: the cable is
   both).
2. Find its new address (the DHCP server of the new network, or
   `scripts/readdress-camera.sh --find` on the target).
3. Point the target at it: `scripts/readdress-camera.sh --id <camera> --host
   <address>`. The proxy checks it's the same camera (pinned certificate,
   login, model) first.
4. Give it a **fixed address** on the new network (a DHCP lease by MAC), then
   make it take that address now instead of at the next renewal: switch off
   PoE on its switch port for 10 s, or `camera-reboot` from the target. Wait
   until its HTTPS port answers (a login right after boot fails; that's not a
   wrong password), then run `readdress-camera.sh` again with the fixed
   address, with the cams-admin options so cams-admin gets it too.
5. Run `camera-ftp-test` a few times, so different passive ports get used.

## 4. While it copies

- Progress, the estimate and the time left are on cams-admin's Moves page and
  in `GET /api/v1/diag/moves`.
- **End transfer** stops copying and keeps what arrived; **Cancel** hands the
  camera back to the source ([camera-move.md](camera-move.md#ending-a-transfer-early-cancelling)).
- A refused move stays listed with the reason until someone deletes it; delete
  it once read. The audit records stay.

## 5. After the move

1. **Move check** (the target's health item `moveSync`): when the move ends,
   the target compares the camera's SD card with what the two proxies had and
   fetches what's missing. "done, nothing was missing" or "done, N fetched" is
   the good end. A problem names what is still missing.
2. **Inventory:** a clips inventory with the camera compare
   (`POST /control/cameras/<id>/actions/inventory` `{"kind":"clips","camera":true}`),
   and a repair for anything `missing-locally`.
3. **Viewers:** every cams viewer holds changed connection data (new address,
   new CA pins) until an admin confirms it in that viewer. cams-admin's
   dashboard shows "N held" per instance. Sign in to each viewer and confirm.
4. **Source proxy:** it hides the camera and deletes the content the target
   verified. A proxy whose last camera moved away keeps running without one.
5. **Firewall cleanup:** remove the rules for addresses the camera no longer
   has (its old LAN address).
6. **Narrow again** when every camera of a host is on its new network: the CA
   subnet (a rotation), and firewall rules that were only for the move.
