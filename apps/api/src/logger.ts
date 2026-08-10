import { pino, type LoggerOptions } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Opzioni condivise fra il logger autonomo e quello interno di Fastify.
 *
 * Fastify riceve le opzioni, non l'istanza già costruita: passandogli
 * un'istanza pino tipizzata, i tipi del server si legano a quel logger e i
 * plugin non risultano più compatibili.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  name: 'api',
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      }
    : undefined,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'token',
      '*.token',
      'accessToken',
      'refreshToken',
      'SESSION_SECRET',
      'ENCRYPTION_KEY',
    ],
    censor: '[rimosso]',
  },
};

export const logger = pino(loggerOptions);
