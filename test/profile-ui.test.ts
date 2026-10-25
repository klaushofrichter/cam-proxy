// The admin UI's proxy profile card (cams-admin spec 2026-10-25-proxy-profile-design
// §0): the home page asks for it until it is set; the Settings page edits it.
import { describe, expect, it } from 'vitest';
import { draftOf, profileBody, profileProblem, profileRows, showOnHome, warningText, type ProfileView } from '../web/src/lib/profile';

const view = (over: Partial<ProfileView> = {}): ProfileView => ({
  set: true, name: 'een (N100, 1 TB)', cameras: 3, storageGB: 600, held: 1,
  ftp: { enabled: true, port: 2121, passive: { from: 30000, to: 30029 } },
  storage: { budgetBytes: 600e9, usedBytes: 41e9, diskBytes: 1e12, freeBytes: 880e9 },
  hardware: { pi: null, cpuCores: 4, cpuModel: 'Intel N100', memoryBytes: 16e9, load5: 0.7, cpuTempC: 48.5 },
  warnings: [], firewall: { tool: 'ufw', lines: ['sudo ufw allow from 192.0.2.85 to any port 2121 proto tcp'] },
  perCameraBytes: 200e9, ...over,
});

describe('the profile card', () => {
  it('shows on the home page until the profile is set, and while it warns', () => {
    expect(showOnHome(null)).toBe(false);
    expect(showOnHome(view({ set: false }))).toBe(true);
    expect(showOnHome(view())).toBe(false);
    expect(showOnHome(view({ warnings: ['profile_ftp_ports'] }))).toBe(true);
  });
  it('rows: cameras held of capacity, budget against the disk, per camera, hardware', () => {
    expect(profileRows(view())).toEqual([
      { key: 'cameras', label: 'Cameras', text: '1 of 3' },
      { key: 'ftp', label: 'FTP ports', text: '2121, passive 30000–30029' },
      { key: 'budget', label: 'Storage budget', text: '600.0 GB (used 41.0 GB) on a 1000.0 GB disk' },
      { key: 'perCamera', label: 'Per camera when full', text: '200.0 GB' },
      { key: 'hardware', label: 'Hardware (as seen by cam-proxy)', text: '4 cores, Intel N100, 16.0 GB memory' },
      { key: 'load', label: 'Load (5 min)', text: '0.70' },
      { key: 'temp', label: 'CPU temperature', text: '48.5 °C' },
    ]);
    const unset = profileRows(view({ set: false, name: null, cameras: 1, storageGB: null, ftp: { enabled: false, port: 2121, passive: null }, storage: { budgetBytes: null, usedBytes: null, diskBytes: null, freeBytes: null }, hardware: { pi: 'Raspberry Pi 4 Model B', cpuCores: 4, cpuModel: null, memoryBytes: 4e9, load5: 0, cpuTempC: null }, perCameraBytes: null }));
    expect(unset.find((r) => r.key === 'cameras')!.text).toBe('1 of 1 (not set: the cameras it holds)');
    expect(unset.find((r) => r.key === 'ftp')!.text).toBe('off');
    expect(unset.find((r) => r.key === 'budget')!.text).toBe('—');
    expect(unset.find((r) => r.key === 'hardware')!.text).toBe('Raspberry Pi 4 Model B, 4 cores, 4.0 GB memory');
    expect(unset.some((r) => r.key === 'temp')).toBe(false);
  });
  it('warnings in words', () => {
    expect(warningText('profile_ftp_ports', view({ cameras: 3, ftp: { enabled: true, port: 2121, passive: { from: 30000, to: 30019 } } }))).toBe('ftp.passive has 20 ports; 3 cameras need 30 (10 per camera). A camera move that needs the missing ports is refused.');
    expect(warningText('profile_cameras_exceeded', view({ cameras: 2, held: 3 }))).toBe('This proxy holds 3 cameras, more than its profile (2). Nothing is removed; camera moves onto it are refused.');
  });
  it('the form: a draft from the view, checked, and the PUT body (empty clears)', () => {
    expect(draftOf(view({ set: false, name: null, storageGB: null, cameras: 2 }))).toEqual({ name: '', cameras: '2', storageGB: '', firewall: 'ufw' });
    expect(profileProblem({ name: '', cameras: '0', storageGB: '', firewall: 'ufw' }, true)).toBe('Cameras: a whole number from 1 to 10 (FTP is on)');
    expect(profileProblem({ name: '', cameras: '11', storageGB: '', firewall: 'ufw' }, false)).toBeNull();
    expect(profileProblem({ name: '', cameras: '65', storageGB: '', firewall: 'ufw' }, false)).toBe('Cameras: a whole number from 1 to 64');
    expect(profileProblem({ name: 'x'.repeat(61), cameras: '2', storageGB: '', firewall: 'ufw' }, false)).toBe('Name: at most 60 characters');
    expect(profileProblem({ name: '', cameras: '2', storageGB: '1.5', firewall: 'ufw' }, false)).toBe('Storage: a whole number of GB from 1 to 100000, or empty');
    expect(profileBody({ name: ' een ', cameras: '3', storageGB: '', firewall: 'nft' })).toEqual({ name: 'een', cameras: 3, storageGB: null, firewall: 'nft' });
    expect(profileBody({ name: '', cameras: '3', storageGB: '600', firewall: 'ufw' })).toEqual({ name: null, cameras: 3, storageGB: 600, firewall: 'ufw' });
  });
});
