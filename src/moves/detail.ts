// The `detail` of a refused move offer (move.offer result, move.answer args;
// cams-admin contract v1: a string of 1 to 300 characters): one line, control
// characters replaced by a space, runs of spaces collapsed, at most 300
// characters (code points, as JSON Schema counts them). undefined when nothing
// is left. Its sources name settings and variables, never a secret's value.
export const DETAIL_MAX = 300;

export function moveDetail(s: string): string | undefined {
  const line = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = [...line].slice(0, DETAIL_MAX).join('').trimEnd();
  return cut || undefined;
}
