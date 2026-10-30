import { describe, expect, it } from 'vitest';
import { isPlaintext, PLAINTEXT_WARNING, timeSetText, addCameraBody, passwordConfirmText, passwordError, retryMinutes, stepLine, trustConfirmText, trustNeeded, STEP_LABELS } from '../web/src/lib/onboarding';

// The admin UI's onboarding texts (spec 2026-10-30-camera-onboarding-design §4.1, §4.4, §4.5).
const FP = `SHA256:${'A'.repeat(64)}`;
describe('the onboarding dialogs and card', () => {
  it('confirm lines', () => {
    expect(passwordConfirmText('Den', '192.0.2.10')).toBe('Save the login for Den (192.0.2.10) on this proxy?');
    expect(trustConfirmText('Den', FP)).toBe(`Trust the certificate ${FP} of Den? Only if it matches what the camera shows.`);
  });
  it('password errors in plain words', () => {
    expect(passwordError('camera_refused')).toBe('The camera refused this password.');
    expect(passwordError('camera_offline')).toBe('The camera did not answer: is it on and reachable?');
    expect(passwordError('too_many_attempts', { retryAfterS: 300 })).toBe('Too many tries: wait 5 minutes.');
    expect(passwordError('too_many_attempts', { retryAfterS: 30 })).toBe('Too many tries: wait 1 minute.');
    expect(passwordError('env_password', { envName: 'CAMPROXY_CAMERA_PASSWORD_CAM1' })).toBe('The password is set in the environment (CAMPROXY_CAMERA_PASSWORD_CAM1): remove it there first.');
    expect(passwordError('not_trusted')).toBe("Trust the camera's certificate first.");
    expect(passwordError('invalid')).toBe('1 to 64 characters, no control characters.');
    expect(passwordError('local_admin_only')).toBe('Not saved: local_admin_only');
    expect(retryMinutes('at most 5 password attempts per camera address in 10 minutes; try again in 412 s')).toBe(412);
    expect(retryMinutes('nothing')).toBeUndefined();
  });
  it('one line per step', () => {
    expect(Object.keys(STEP_LABELS)).toHaveLength(11);
    expect(stepLine('trust', { ok: false, detail: 'certificate not trusted', action: 'camera-trust-pin' })).toBe('Certificate: certificate not trusted');
    expect(stepLine('ftp', { ok: true, detail: 'off' })).toBe('FTP uploads: off');
    expect(stepLine('time', { ok: null, detail: '' })).toBe('Time: not known yet');
  });
  it('the trust button: only with a fix to pin and a measured certificate', () => {
    const st = { trust: { mode: 'none', fingerprint: null, served: FP }, steps: { trust: { ok: false, detail: 'certificate not trusted', action: 'camera-trust-pin' } } };
    expect(trustNeeded(st)).toBe(FP);
    expect(trustNeeded({ ...st, trust: { ...st.trust, served: null } })).toBeNull();
    expect(trustNeeded({ ...st, steps: { trust: { ok: true, detail: '' } } })).toBeNull();
  });
  it('plain http is said plainly (security review 5)', () => {
    expect(PLAINTEXT_WARNING).toBe('This camera uses plain HTTP: the password travels unencrypted on your network.');
    expect(isPlaintext({ steps: { trust: { ok: false, detail: 'plain http: no certificate' } } })).toBe(true);
    expect(isPlaintext({ steps: { trust: { ok: false, detail: 'certificate not trusted', action: 'camera-trust-pin' } } })).toBe(false);
  });
  it('the camera time answer in words', () => {
    expect(timeSetText({ outcome: 'set', zone: 'Europe/Berlin', ntp: 'already' })).toBe('Camera time zone set to Europe/Berlin.');
    expect(timeSetText({ outcome: 'already', zone: 'Europe/Berlin', ntp: null })).toBe('The camera already runs in Europe/Berlin.');
    expect(timeSetText({ outcome: 'failed', zone: 'Asia/Tokyo', ntp: null, detail: 'x' })).toBe('Not set (Asia/Tokyo): x');
    expect(timeSetText({ outcome: 'unsupported', zone: 'Asia/Tokyo', ntp: null })).toBe("This camera can't set its time zone.");
  });
  it('the add body: trimmed, id optional, the fingerprint only over https', () => {
    expect(addCameraBody({ id: ' cam6 ', name: '', host: ' 192.0.2.16 ', protocol: 'https', user: '', password: 'pw', fingerprint: FP })).toEqual({ id: 'cam6', host: '192.0.2.16', protocol: 'https', user: 'admin', password: 'pw', trust: { fingerprint: FP } });
    expect(addCameraBody({ id: '', name: 'Gate', host: '192.0.2.16', protocol: 'http', user: 'proxy', password: 'pw', fingerprint: null })).toEqual({ name: 'Gate', host: '192.0.2.16', protocol: 'http', user: 'proxy', password: 'pw' });
    expect(addCameraBody({ id: 'cam6', name: '', host: '192.0.2.16', protocol: 'http', user: 'proxy', password: 'pw', fingerprint: null, ftp: true }).ftp).toBe(true);
  });
});
