// Test-only values for the multi-camera e2e run; not secrets.
export const PROXY_PORT = 18680;
export const SIMS = [
  { name: 'Driveway', http: 18700, https: 18701, control: 18702, onvif: 18703, rtsp: 18704 },
  { name: 'Gate', http: 18710, https: 18711, control: 18712, onvif: 18713, rtsp: 18714 },
  { name: 'Garden', http: 18720, https: 18721, control: 18722, onvif: 18723, rtsp: 18724 },
];
export const ADMIN_TOKEN = 'e2e-multi-admin-token-not-a-secret-00000000';
export const CLIENT_TOKEN = 'e2e-multi-client-token-not-a-secret-0000000';
export const STATE_FILE = 'e2e/.auth/multi.json';
