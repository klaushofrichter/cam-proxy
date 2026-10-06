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
// The PoE switch mock (#85): its web protocol on this port; PoE on port 8 is cam-sim's power.
export const POE_SWITCH_PORT = 18601;
export const POE_SWITCH_PASSWORD = 'e2e-switch-password-not-a-secret';
// The shared admin session (auth.setup.ts writes it; playwright.config.ts reads it).
export const STATE_FILE = 'e2e/.auth/state.json';
// Find camera (pi-config spec §3): a fake ONVIF WS-Discovery responder on this UDP port.
export const DISCOVERY_PORT = 18602;
// A cams-admin-managed client token seeded into data/admin/tokens.json (migration P2; test-only).
export const MANAGED_TOKEN = 'e2e-managed-client-token-not-a-secret-000';
export const MANAGED_TOKEN_ID = 'tok_E2E0000000000000000M';
