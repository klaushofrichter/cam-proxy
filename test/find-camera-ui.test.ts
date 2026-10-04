import { describe, expect, it } from 'vitest';
import { deviceLabel, envNote, foundText, handLine, isEnvSet, notAvailableText, useAddressMessage, writtenText } from '../web/src/lib/find-camera';

// Settings → Find camera, and the settings set in .env (spec
// 2026-10-04-pi-config-design §1, §3, §4).
describe('the Settings page: settings set in .env', () => {
  it('a setting with source env is read-only, with its variable', () => {
    expect(isEnvSet({ source: 'env', env: 'PI_ADDRESS' })).toBe(true);
    expect(isEnvSet({ source: 'override' })).toBe(false);
    expect(isEnvSet({ source: 'file' })).toBe(false);
    expect(envNote({ source: 'env', env: 'PI_ADDRESS' })).toBe('set in .env (PI_ADDRESS)');
    expect(envNote({ source: 'env' })).toBe('set in .env');
  });
});

describe('Find camera', () => {
  const dev = { endpoint: 'urn:uuid:1', address: '192.168.1.20', xaddrs: [], name: 'RLC-1224A', hardware: 'RLC-1224A', model: 'RLC-1224A', current: false };
  it('labels a device by name, adding the model when it differs', () => {
    expect(deviceLabel(dev)).toBe('RLC-1224A');
    expect(deviceLabel({ ...dev, name: 'Garage Cam', model: 'XY-100' })).toBe('Garage Cam (XY-100)');
    expect(deviceLabel({ ...dev, name: null, model: 'XY-100' })).toBe('XY-100');
    expect(deviceLabel({ ...dev, name: null, model: null, hardware: null })).toBe('unnamed ONVIF device');
  });
  it('says what was found', () => {
    expect(foundText(0, 3012)).toBe('No ONVIF camera answered within 3 s. Is the camera on this LAN, with ONVIF on?');
    expect(foundText(1, 3012)).toBe('1 device answered.');
    expect(foundText(2, 3012)).toBe('2 devices answered.');
  });
  it('asks before writing, and says what happens', () => {
    expect(useAddressMessage('192.168.1.20', '/config/.env')).toBe('Use 192.168.1.20 as the camera address? This writes CAMERA_HOST=192.168.1.20 into /config/.env (a backup is kept next to it) and restarts the proxy; you sign in again afterwards. Then use "Point the camera\'s FTP here" on the Maintenance page if the camera should upload here.');
    expect(writtenText({ host: '192.168.1.20', previous: '10.0.0.1', backup: '.env.bak-20261004-130509' })).toBe('CAMERA_HOST=192.168.1.20 written (was 10.0.0.1; backup .env.bak-20261004-130509). Restarting the proxy…');
    expect(writtenText({ host: '192.168.1.20', previous: null, backup: 'b' })).toBe('CAMERA_HOST=192.168.1.20 written (was not set; backup b). Restarting the proxy…');
  });
  it('without a writable .env file: the line to add by hand', () => {
    expect(handLine('192.168.1.20')).toBe('CAMERA_HOST=192.168.1.20');
    expect(notAvailableText('CAMPROXY_ENV_FILE is not set')).toBe("The proxy can't write its .env file (CAMPROXY_ENV_FILE is not set). Add this line to the .env file by hand (replace an existing CAMERA_HOST line), then recreate the container (docker compose up -d):");
  });
});
