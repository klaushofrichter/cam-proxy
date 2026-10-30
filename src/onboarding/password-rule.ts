// A camera password as the onboarding APIs take it: 1 to 64 characters, no
// control characters (the camera's own limit may be lower; it says so by refusing).
// eslint-disable-next-line no-control-regex
export const validPassword = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v);
export const PASSWORD_RULE = 'password: 1 to 64 characters, no control characters';
