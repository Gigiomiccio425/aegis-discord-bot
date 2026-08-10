import { pino } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  name: 'worker',
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined,
  redact: {
    paths: ['token', '*.token', 'DISCORD_TOKEN', 'password', '*.password', 'authorization'],
    censor: '[rimosso]',
  },
});

export function childLogger(module: string) {
  return logger.child({ module });
}
