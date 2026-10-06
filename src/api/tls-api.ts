import express from 'express';
import type { SiteCa } from '../tls/ca';

// The site CA's certificate, public (spec 2026-10-05-multi-camera-host-design
// §10.1.4): cams fetches it and accepts it only if its fingerprint matches its
// pin. Only this one path; never a key. Mounted on /tls.
export function tlsApi(d: { ca: () => SiteCa | null }): express.Router {
  const r = express.Router({ caseSensitive: true, strict: true });
  r.get('/ca.pem', (_req, res) => {
    const ca = d.ca();
    if (!ca) return void res.status(404).json({ error: 'no_site_ca' });
    res.type('application/x-pem-file').set('Cache-Control', 'no-cache').send(ca.certPem);
  });
  return r;
}
