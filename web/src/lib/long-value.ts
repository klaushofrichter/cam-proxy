// Long values in the admin UI (#203): ids, hashes, fingerprints and URLs.
// An id is shortened in the middle (its prefix and its last characters both
// identify it); the full value goes into the title and the copy button. A
// fingerprint is shown in groups of four that wrap only between groups.

export function shortId(id: string, head = 8, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function fingerprintChunks(fp: string): { algo: string | null; groups: string[] } {
  const m = /^([A-Za-z0-9-]+):(.*)$/.exec(fp);
  const body = m ? m[2] : fp;
  return { algo: m ? m[1] : null, groups: body.match(/.{1,4}/g) ?? [] };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
