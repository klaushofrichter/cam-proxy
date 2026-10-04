// The camera's name rules (camera-name design, measured on cam1, firmware
// v3.2.0.6011, 2026-10-03): 1 to 31 characters; ASCII letters, digits, space
// and - ( ) + = [ ] { }; no leading or trailing space. Anything else the
// camera refuses with rspCode -54, a longer name with -56, and a refused write
// leaves the old name. cams keeps the same list (the regex is the contract).
//
// No imports: the admin UI (web/) uses this file too.

export const CAMERA_NAME_MAX = 31;
export const CAMERA_NAME_RE = /^[A-Za-z0-9()+=\[\]{}-](?:[A-Za-z0-9 ()+=\[\]{}-]{0,29}[A-Za-z0-9()+=\[\]{}-])?$/;
const ALLOWED = /^[A-Za-z0-9 ()+=\[\]{}-]$/;

// A refused character as people can read it (a control character as \uXXXX).
const shown = (c: string) => (/\p{C}|\s/u.test(c) ? `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}` : c);

// Why the camera would refuse `name`, or null when it takes it. Short: cams
// shows at most 64 characters of a reason.
export function cameraNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'empty: 1 to 31 characters';
  if (name.length > CAMERA_NAME_MAX) return `too long: ${name.length} characters, at most 31`;
  const bad = [...new Set([...name].filter((c) => !ALLOWED.test(c)))];
  if (bad.length) return `not allowed: ${bad.slice(0, 8).map(shown).join(' ')}`;
  if (name.startsWith(' ') || name.endsWith(' ')) return 'no leading or trailing space';
  return CAMERA_NAME_RE.test(name) ? null : 'not allowed';
}
