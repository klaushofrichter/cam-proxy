// A camera's own password variable (spec 2026-10-05-multi-camera-host-design
// §4.3): CAMPROXY_CAMERA_PASSWORD_<ID>, the id upper-cased, - → _. Pure: the
// admin UI names it too.
export const cameraPasswordEnv = (id: string): string => `CAMPROXY_CAMERA_PASSWORD_${id.toUpperCase().replace(/-/g, '_')}`;
