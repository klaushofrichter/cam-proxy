import { reapStrays } from './helpers/strays';

// #119: media children left by an earlier aborted or crashed run go before
// this run starts, and those of workers killed in this run at its end.
const reap = (when: string) => {
  const pids = reapStrays();
  if (pids.length) console.log(`test ${when}: killed ${pids.length} stray MediaMTX/go2rtc of an aborted test run (${pids.join(', ')})`);
};

export default function setup(): () => void {
  reap('setup');
  return () => reap('teardown');
}
