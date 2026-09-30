import { AnalyticsError, type AnalyticsProvider, type Found } from './providers';

type Vertex = { x?: number; y?: number };
type Annotation = { name?: unknown; score?: unknown; boundingPoly?: { normalizedVertices?: Vertex[] } };

// Google Cloud Vision, object localization only (1 unit per image). The key
// goes in X-Goog-Api-Key, never in the URL (it would reach logs).
export function googleVision(o: { key: string; baseUrl: string }): AnalyticsProvider {
  return {
    id: 'google-vision',
    name: 'Google Vision',
    async analyze(jpeg, signal) {
      let res: Response;
      try {
        res = await fetch(`${o.baseUrl}/v1/images:annotate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': o.key },
          body: JSON.stringify({ requests: [{ image: { content: jpeg.toString('base64') }, features: [{ type: 'OBJECT_LOCALIZATION', maxResults: 20 }] }] }),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw new AnalyticsError('timeout', true);
        throw new AnalyticsError('network', true);
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new AnalyticsError('bad_key', false, 'bad_key');
      if (res.status === 429) throw new AnalyticsError('quota', false, 'quota');
      if (res.status >= 500) throw new AnalyticsError('http_5xx', true);
      if (res.status !== 200) throw new AnalyticsError(`http_${res.status}`, false);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AnalyticsError('bad_response', false);
      }
      const first = (body as { responses?: unknown[] })?.responses?.[0] as { error?: unknown; localizedObjectAnnotations?: Annotation[] } | undefined;
      if (!first || typeof first !== 'object' || first.error) throw new AnalyticsError('bad_response', false);
      const anns = Array.isArray(first.localizedObjectAnnotations) ? first.localizedObjectAnnotations : [];
      const objects: Found[] = anns.map((a) => {
        const v = a.boundingPoly?.normalizedVertices ?? [];
        const xs = v.map((p) => p.x ?? 0);
        const ys = v.map((p) => p.y ?? 0);
        return {
          name: String(a.name ?? 'object'),
          score: typeof a.score === 'number' ? a.score : 0,
          box: { x0: Math.min(1, ...xs), y0: Math.min(1, ...ys), x1: Math.max(0, ...xs), y1: Math.max(0, ...ys) },
        };
      });
      return { objects, raw: { localizedObjectAnnotations: anns } };
    },
  };
}
