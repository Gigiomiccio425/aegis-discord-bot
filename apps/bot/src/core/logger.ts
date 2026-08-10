import { pino } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // In produzione JSON su stdout: è ciò che Docker e ZimaOS raccolgono.
  // In sviluppo output leggibile.
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined,
  redact: {
    // Un token nei log è un token compromesso.
    paths: ['token', '*.token', 'DISCORD_TOKEN', 'password', '*.password', 'authorization'],
    censor: '[rimosso]',
  },
});

export type Logger = typeof logger;

export function childLogger(module: string): Logger {
  return logger.child({ module });
}
