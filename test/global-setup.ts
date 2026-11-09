import { join } from 'path';
import { staleDeps } from './helpers/stale-deps';
import { reapStrays } from './helpers/strays';

// #119: media children left by an earlier aborted or crashed run go before
// this run starts, and those of workers killed in this run at its end.
const reap = (when: string) => {
  const pids = reapStrays();
  if (pids.length) console.log(`test ${when}: killed ${pids.length} stray MediaMTX/go2rtc of an aborted test run (${pids.join(', ')})`);
};

export default function setup(): () => void {
  // A node_modules older than the lock tests old code (cam-sim above all): stop with the reason.
  const stale = staleDeps(join(__dirname, '..'));
  if (stale.length) throw new Error(`node_modules does not match package-lock.json; run npm ci:\n  ${stale.slice(0, 5).join('\n  ')}`);
  reap('setup');
  return () => reap('teardown');
}
