import 'dotenv/config';
import { REST, Routes, type Client } from 'discord.js';
import { commands } from '../commands/index.js';
import { buildSlashCommand, loadCustomCommands } from '../personas/customCommands.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('deploy');

/**
 * Registrazione dei comandi slash.
 *
 * I comandi globali impiegano fino a un'ora a propagarsi; quelli di server
 * sono immediati. Poiché i comandi personalizzati cambiano ogni volta che
 * qualcuno tocca il pannello, vengono registrati per server: attendere un'ora
 * per vedere il proprio comando renderebbe il builder inutilizzabile.
 */
export async function deployGlobalCommands(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) throw new Error('DISCORD_TOKEN e DISCORD_CLIENT_ID sono necessari');

  const rest = new REST({ version: '10' }).setToken(token);
  const body = commands.map((command) => command.data.toJSON());

  const devGuild = process.env.DEV_GUILD_ID;
  if (devGuild) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuild), { body });
    log.info({ count: body.length, guildId: devGuild }, 'comandi registrati sulla guild di sviluppo');
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body });
  log.info({ count: body.length }, 'comandi globali registrati (propagazione fino a un\'ora)');
}

/**
 * Comandi di un singolo server: quelli integrati più i personalizzati.
 *
 * La registrazione è sempre completa e sostitutiva: Discord non offre un
 * aggiornamento parziale, e inviare solo i nuovi cancellerebbe gli altri.
 */
export async function deployGuildCommands(client: Client, guildId: string): Promise<void> {
  const clientId = client.user?.id ?? process.env.DISCORD_CLIENT_ID;
  const token = process.env.DISCORD_TOKEN;
  if (!token || !clientId) return;

  const custom = await loadCustomCommands(guildId);
  const builtinNames = new Set(commands.map((command) => command.data.name));

  const body = [
    ...commands.map((command) => command.data.toJSON()),
    // I comandi personalizzati non possono sovrascrivere quelli integrati:
    // altrimenti si potrebbe neutralizzare `/lockdown` dal pannello.
    ...custom
      .filter((command) => !builtinNames.has(command.name))
      .map((command) => buildSlashCommand(command).toJSON()),
  ];

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  log.info({ guildId, total: body.length, custom: custom.length }, 'comandi del server registrati');
}

// Esecuzione diretta: `npm run commands:deploy`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  void deployGlobalCommands()
    .then(() => process.exit(0))
    .catch((error) => {
      log.fatal({ err: error }, 'registrazione comandi fallita');
      process.exit(1);
    });
}
