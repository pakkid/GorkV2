import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageReaction,
  Partials,
  type PartialMessageReaction,
} from 'discord.js';
import { onMessage } from './brain';
import { commands } from './commands';
import { activities, statuses } from './config';
import { deployCommands } from './deploy-commands';
import { env } from './env';
import {
  peekLog,
  recordDelete,
  recordEdit,
  recordMessage,
  recordReaction,
} from './history';
import { logger } from './log';
import { settings } from './settings';

const log = logger('core');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

const pick = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)]!;

function rotatePresence() {
  const activity = pick(activities);
  client.user?.setPresence({ status: pick(statuses), activities: [activity] });
  setTimeout(rotatePresence, (5 + Math.random() * 5) * 60_000);
}

client.once(Events.ClientReady, (c) => {
  log.info(`logged in as ${c.user.tag} in ${c.guilds.cache.size} servers`);
  rotatePresence();
  // keeps slash commands in sync on every start, so deploys need no extra step
  deployCommands().catch((error) => log.warn('failed to register slash commands', error));
});

client.on(Events.MessageCreate, async (message: Message) => {
  try {
    if (message.partial) message = await message.fetch();
    // channels set to none are invisible to gork: not read, not archived
    if (settings.mode(message.guildId, message.channelId) === 'none') return;
    const msg = recordMessage(message);
    if (!msg || message.author.bot || msg.self) return;
    onMessage(message, msg);
  } catch (error) {
    log.error('messageCreate failed', error);
  }
});

client.on(Events.MessageUpdate, (_old, message) => {
  if (settings.mode(message.guildId, message.channelId) === 'none') return;
  recordEdit(message);
});
client.on(Events.MessageDelete, (message) => recordDelete(message.channelId, message.id));
client.on(Events.MessageBulkDelete, (messages) => {
  for (const m of messages.values()) recordDelete(m.channelId, m.id);
});

const onReaction = (reaction: MessageReaction | PartialMessageReaction) => {
  const { message } = reaction;
  if (reaction.partial || !peekLog(message.channelId)?.byId.has(message.id)) return;
  recordReaction(message.channelId, message.id, reaction.emoji, reaction.count);
};
client.on(Events.MessageReactionAdd, onReaction);
client.on(Events.MessageReactionRemove, onReaction);

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands[interaction.commandName];
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    log.error(`/${interaction.commandName} failed`, error);
  }
});

client.on(Events.GuildCreate, (guild) => log.info(`joined ${guild.name} (${guild.id})`));
client.on(Events.GuildDelete, (guild) => log.info(`left ${guild.name} (${guild.id})`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    log.info(`${signal}, bye`);
    await client.destroy();
    process.exit(0);
  });
}

await client.login(env.DISCORD_TOKEN);
