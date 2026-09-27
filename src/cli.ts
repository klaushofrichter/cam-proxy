import { ConfigError, loadConfig } from './config/load';
import { createProxy } from './proxy';
import { logger } from './log';

// Starts cam-proxy from config.json and the environment (spec §14).
async function main(): Promise<void> {
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
  const proxy = createProxy(loaded);
  await proxy.start();
  const shutdown = (sig: string) => {
    logger.info({ sig }, 'cam_proxy_stopping');
    void proxy.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  process.stderr.write(`cam-proxy: ${err.message}\n`);
  process.exit(1);
});
