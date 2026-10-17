import app from './app';
import { Server } from 'http';
import { config } from './config';
import { closeDatabase } from './database';
import { runMigrations } from './database/migrations';
import logger from './utils/logger';

let server: Server | undefined;
let stopping = false;

async function start() {
  await runMigrations();
  logger.info('Database migrations completed');
  if (stopping) return;
  server = app.listen(config.port);
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  logger.info(`Server is running on http://localhost:${port}`);
}

function finish(exitCode: number) {
  process.exitCode = exitCode;
  logger.once('finish', () => process.exit(exitCode));
  logger.end();
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal} received; waiting for active requests to complete`);
  // Leave time within the configured 30-second Docker stop grace period.
  const deadline = setTimeout(() => {
    logger.error('Graceful shutdown exceeded 25 seconds; forcing exit');
    server?.closeAllConnections();
    process.exit(1);
  }, 25_000);
  deadline.unref();

  let exitCode = 0;
  try {
    // A migration may still be writing its snapshot when a stop arrives.
    await startup;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close(error => error ? reject(error) : resolve());
      });
    }
  } catch (error) {
    exitCode = 1;
    logger.error(`Shutdown failed: ${(error as Error).message}`);
  }
  try {
    closeDatabase();
    logger.info('Shutdown completed; database closed');
  } catch (error) {
    exitCode = 1;
    logger.error(`Database close failed: ${(error as Error).message}`);
  }
  finish(exitCode);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

const startup = start();
startup.catch(error => {
  if (stopping) return;
  logger.error(`Startup failed: ${error.message}`);
  try { closeDatabase(); } catch (closeError) {
    logger.error(`Database close failed: ${(closeError as Error).message}`);
  }
  finish(1);
});
