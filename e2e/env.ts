// Test-only values for the e2e run; not secrets.
export const PROXY_PORT = 18480;
export const SIM = { http: 18580, https: 18581, control: 18582, onvif: 18583, rtsp: 18584 };
export const FTP = { port: 18587, passive: '18590-18599' };
export const FTP_PASSWORD = 'e2e-ftp-password-not-a-secret';
export const ADMIN_TOKEN = 'e2e-admin-token-not-a-secret-000000000000';
export const CLIENT_TOKEN = 'e2e-client-token-not-a-secret-00000000000';
export const SIM_CONTROL_TOKEN = 'e2e-sim-control-token-not-a-secret';
export const VISION_MOCK_PORT = 18600;
export const VISION_KEY = 'e2e-vision-key-not-a-secret';
// The shared admin session (auth.setup.ts writes it; playwright.config.ts reads it).
export const STATE_FILE = 'e2e/.auth/state.json';
