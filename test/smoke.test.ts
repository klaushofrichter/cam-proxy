import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createCamSim } from 'cam-sim';

// cam-sim, the simulated camera every test runs against, is importable and
// answers the camera API in process.
describe('cam-sim dev dependency', () => {
  it('answers GetDevInfo', async () => {
    const sim = await createCamSim({ users: [{ name: 'admin', level: 'admin', password: 'admin-pw' }] });
    try {
      const login = await request(sim.cameraApp).post('/cgi-bin/api.cgi?cmd=Login')
        .send([{ cmd: 'Login', action: 0, param: { User: { Version: '0', userName: 'admin', password: 'admin-pw' } } }]);
      const token = JSON.parse(login.text)[0].value.Token.name;
      const dev = await request(sim.cameraApp).post(`/cgi-bin/api.cgi?cmd=GetDevInfo&token=${token}`).send([{ cmd: 'GetDevInfo', action: 0, param: {} }]);
      expect(JSON.parse(dev.text)[0].value.DevInfo.model).toBe('RLC-1224A');
    } finally {
      await sim.close();
    }
  });
});
