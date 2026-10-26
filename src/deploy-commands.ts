import { REST, Routes } from 'discord.js';
import { commands } from './commands';
import { env } from './env';
import { logger } from './log';

const log = logger('deploy');
const rest = new REST().setToken(env.DISCORD_TOKEN);
const body = Object.values(commands).map((c) => c.data.toJSON());

export async function deployCommands(guildId?: string) {
  const route = guildId
    ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId)
    : Routes.applicationCommands(env.DISCORD_CLIENT_ID);
  await rest.put(route, { body });
  log.info(`deployed ${body.length} commands ${guildId ? `to ${guildId}` : 'globally'}`);
}

if (import.meta.main) {
  await deployCommands(process.argv[2]);
}
