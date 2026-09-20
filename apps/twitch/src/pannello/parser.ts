import type { FastifyInstance } from 'fastify';

/**
 * Il corpo vuoto con `content-type: application/json`.
 *
 * Il client manda sempre quell'intestazione — è ciò che obbliga un altro
 * sito a passare dal preflight — anche quando non c'è niente da mandare:
 * uscire, togliere un accesso, staccare il canale. Il parser di Fastify
 * risponde 400 a un corpo vuoto con quell'intestazione, e quei tre pulsanti
 * non hanno mai funzionato.
 *
 * Si usa lo stesso parser di Fastify, che resta quello sicuro contro
 * `__proto__`, lasciando passare solo il corpo vuoto.
 */
export function installaParserJson(app: FastifyInstance): void {
  const predefinito = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, corpo, fatto) => {
    if (corpo === '' || corpo === undefined) {
      fatto(null, {});
      return;
    }
    predefinito(request, corpo as string, fatto);
  });
}
