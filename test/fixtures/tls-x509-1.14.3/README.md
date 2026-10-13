# TEST DATA ONLY: not a real CA, not a real camera key

A site CA (`ca.pem`, `ca.key`) and a camera leaf (`leaf.pem`, `leaf.key`) generated on 2026-10-13 with `src/tls/{ca,leaf,der}.ts` and @peculiar/x509 1.14.3, for `test/tls-x509-compat.test.ts` (a CA made before the 2.x upgrade still loads, issues and verifies). Site `fixture`, documentation addresses only (192.0.2.0/24, 198.51.100.10). Never trust this CA anywhere.
