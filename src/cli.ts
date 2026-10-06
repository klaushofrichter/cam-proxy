import { ConfigError, envSummary, loadConfig } from './config/load';
import { createProxy } from './proxy';
import { logger } from './log';
import { shutdownHandler } from './shutdown';
import { runAdminCli } from './fleet/cli';

// Starts cam-proxy from config.json and the environment (spec §14).
// `admin-enroll --url U` / `admin-unenroll`: cams-admin enrollment (src/fleet/cli.ts).
async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'admin-enroll' || cmd === 'admin-unenroll') {
    const code = await runAdminCli(process.argv.slice(2), { env: process.env, cwd: process.cwd(), stdin: process.stdin, out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) });
    process.exit(code);
  }
  let loaded;
  try {
    loaded = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`cam-proxy: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  // A restart-proxy action stops the proxy and exits 0; compose or the
  // cluster starts it again (#71).
  const proxy = createProxy(loaded, { exit: (code) => process.exit(code) });
  // Which settings the environment (the Pi's .env) set: addresses only.
  logger.info(envSummary(loaded), 'config_env');
  // Before the start: a signal during it stops what has started. A stop over
  // 15 s (a Vision call in flight may take 10; compose gives 20), or a second
  // signal, kills the children and exits 1.
  const onSignal = shutdownHandler({ stop: (reason) => proxy.stop({ reason }), exit: (code) => process.exit(code), timeoutMs: 15_000 });
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  await proxy.start();
}

main().catch((err: Error) => {
  process.stderr.write(`cam-proxy: ${err.message}\n`);
  process.exit(1);
});
