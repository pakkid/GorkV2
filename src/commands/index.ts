import {
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  InteractionContextType,
  PermissionFlagsBits,
  MessageFlags,
  SlashCommandBuilder,
  type SlashCommandStringOption,
  type TextBasedChannel,
} from 'discord.js';
import { crawlChannel, latestMessages, wipeArchive } from '../archive';
import { limits, memory as memoryCfg } from '../config';
import { formatTime } from '../history';
import { logger } from '../log';
import { forgetAll, notes, rebuildNotes } from '../memory';
import { env } from '../env';
import {
  type ResponseMode,
  type SafetyMode,
  type Scope,
  settings,
} from '../settings';

const log = logger('commands');
const ephemeral = MessageFlags.Ephemeral;

const modeLabels: Record<ResponseMode, string> = {
  relevance: 'relevance (gork decides)',
  ping: 'ping only',
  'ping+keyword': 'ping + keyword',
  none: 'none',
};

// only the bot owner (DISCORD_OWNER_ID) can change gork's settings
function canEdit(interaction: ChatInputCommandInteraction) {
  return !!env.DISCORD_OWNER_ID && interaction.user.id === env.DISCORD_OWNER_ID;
}

const scopeOption = (required: boolean) => (o: SlashCommandStringOption) =>
  o
    .setName('scope')
    .setDescription('Whole server or just this channel')
    .setRequired(required)
    .addChoices(
      { name: 'Server', value: 'guild' },
      { name: 'Channel', value: 'channel' }
    );

/** /mode and /safety share the same set/show/clear shape */
function scopedSetting<T extends string>(opts: {
  name: string;
  description: string;
  choices: { name: string; value: T }[];
  labels: Record<T, string>;
  get: (guildId: string, channelId: string) => T;
  stored: (scope: Scope, id: string) => T | undefined;
  set: (scope: Scope, id: string, value: T | null) => void;
}) {
  const data = new SlashCommandBuilder()
    .setName(opts.name)
    .setDescription(opts.description)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription(`Set the ${opts.name}`)
        .addStringOption(scopeOption(true))
        .addStringOption((o) =>
          o
            .setName('value')
            .setDescription(`The ${opts.name}`)
            .setRequired(true)
            .addChoices(...opts.choices)
        )
    )
    .addSubcommand((s) =>
      s.setName('show').setDescription(`Show the current ${opts.name}`)
    )
    .addSubcommand((s) =>
      s
        .setName('clear')
        .setDescription(`Clear the ${opts.name} override`)
        .addStringOption(scopeOption(true))
    );

  async function execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.reply({ content: 'this only works in a server', flags: ephemeral });
    }
    const sub = interaction.options.getSubcommand();

    if (sub === 'show') {
      const server = opts.stored('guild', guildId);
      const channel = opts.stored('channel', interaction.channelId);
      const effective = opts.get(guildId, interaction.channelId);
      return interaction.reply({
        content: [
          `server: **${server ? opts.labels[server] : `default (${opts.labels[opts.get(guildId, '')]})`}**`,
          `this channel: **${channel ? opts.labels[channel] : 'inherits server'}**`,
          `effective here: **${opts.labels[effective]}**`,
        ].join('\n'),
        flags: ephemeral,
      });
    }

    if (!canEdit(interaction)) {
      return interaction.reply({ content: 'nah only my owner gets to touch that', flags: ephemeral });
    }
    const scope = interaction.options.getString('scope', true) as Scope;
    const id = scope === 'guild' ? guildId : interaction.channelId;
    const where = scope === 'guild' ? 'this server' : `<#${id}>`;

    if (sub === 'set') {
      const value = interaction.options.getString('value', true) as T;
      opts.set(scope, id, value);
      return interaction.reply({
        content: `${opts.name} for ${where} is now **${opts.labels[value]}**`,
        flags: ephemeral,
      });
    }

    opts.set(scope, id, null);
    return interaction.reply({ content: `cleared ${opts.name} for ${where}`, flags: ephemeral });
  }

  return { data, execute };
}

const mode = scopedSetting<ResponseMode>({
  name: 'mode',
  description: 'Control when gork talks',
  choices: [
    { name: 'Relevance (gork decides)', value: 'relevance' },
    { name: 'Ping only', value: 'ping' },
    { name: 'Ping + keyword', value: 'ping+keyword' },
    { name: 'None', value: 'none' },
  ],
  labels: modeLabels,
  get: (g, c) => settings.mode(g, c),
  stored: (s, id) => settings.storedMode(s, id),
  set: (s, id, v) => settings.setMode(s, id, v),
});

const safety = scopedSetting<SafetyMode>({
  name: 'safety',
  description: 'Content filtering for gork',
  choices: [
    { name: 'Unfiltered', value: 'unfiltered' },
    { name: 'Safe (SFW)', value: 'safe' },
  ],
  labels: { unfiltered: 'unfiltered', safe: 'safe' },
  get: (g, c) => settings.safety(g, c),
  stored: (s, id) => settings.storedSafety(s, id),
  set: (s, id, v) => settings.setSafety(s, id, v),
});

const shutup = {
  data: new SlashCommandBuilder()
    .setName('shutup')
    .setDescription('Tell gork to stop talking in this channel (pings still work)'),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!canEdit(interaction)) {
      return interaction.reply({ content: 'u cant tell me what to do', flags: ephemeral });
    }
    if (settings.isSilenced(interaction.channelId)) {
      return interaction.reply({
        content: 'already shut up. ping me if u want me back',
        flags: ephemeral,
      });
    }
    settings.silence(interaction.channelId, limits.silenceMs);
    return interaction.reply('aight ill shut up. ping me if u want me back');
  },
};

const ping = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check if gork is alive'),
  async execute(interaction: ChatInputCommandInteraction) {
    return interaction.reply({
      content: `pong (${Math.round(interaction.client.ws.ping)}ms)`,
      flags: ephemeral,
    });
  },
};

/** Channels gork is switched on in (and can read), so the ones a reinit re-crawls. */
function activeChannels(interaction: ChatInputCommandInteraction): TextBasedChannel[] {
  const { guild } = interaction;
  if (!guild) return interaction.channel ? [interaction.channel] : [];
  const me = guild.members.me;
  return [...guild.channels.cache.values()].filter(
    (c): c is GuildBasedChannel & TextBasedChannel =>
      c.isTextBased() &&
      settings.mode(guild.id, c.id, c.parentId) !== 'none' &&
      !!me &&
      c.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
  );
}

function splitLines(lines: string[], max = 1900) {
  const out: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

// one reinit per server at a time
const reiniting = new Set<string>();

const memory = {
  data: new SlashCommandBuilder()
    .setName('memory')
    .setDescription("Look at or reset gork's memory")
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addSubcommand((s) => s.setName('show').setDescription('Show what gork remembers about this server'))
    .addSubcommand((s) =>
      s
        .setName('wipe')
        .setDescription("Delete all of gork's notes for this server")
        .addBooleanOption((o) =>
          o.setName('archive').setDescription('Also delete the archived chat history (default: no)')
        )
    )
    .addSubcommand((s) =>
      s
        .setName('reinit')
        .setDescription('Re-download all chat history, then rebuild notes from it (slow)')
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!canEdit(interaction)) {
      return interaction.reply({ content: 'my memories are none of ur business', flags: ephemeral });
    }
    const scope = interaction.guildId ?? interaction.channelId;
    const where = interaction.guild ? `**${interaction.guild.name}**` : 'these DMs';
    const sub = interaction.options.getSubcommand();

    if (sub === 'show') {
      const all = notes(scope, memoryCfg.maxNotes);
      if (!all.length) return interaction.reply({ content: `i remember nothing about ${where}`, flags: ephemeral });
      const [first, ...rest] = splitLines([
        `${all.length} notes about ${where}:`,
        ...all.map((n) => `\`${n.id}\` ${formatTime(n.created_at, true)} · ${n.text}`),
      ]);
      await interaction.reply({ content: first!, flags: ephemeral, allowedMentions: { parse: [] } });
      for (const part of rest) {
        await interaction.followUp({ content: part, flags: ephemeral, allowedMentions: { parse: [] } });
      }
      return;
    }

    if (sub === 'wipe') {
      const removed = forgetAll(scope);
      let msg = `wiped ${removed} notes for ${where}`;
      if (interaction.options.getBoolean('archive')) {
        const channels = activeChannels(interaction);
        const gone = wipeArchive(channels.map((c) => c.id));
        msg += ` and ${gone} archived messages from ${channels.length} channels. run /memory reinit to download them again`;
      }
      return interaction.reply({ content: msg, flags: ephemeral });
    }

    // reinit
    if (reiniting.has(scope)) {
      return interaction.reply({ content: 'already reinitializing, chill', flags: ephemeral });
    }
    const channels = activeChannels(interaction);
    if (!channels.length) {
      return interaction.reply({ content: "i'm not turned on in any channels here", flags: ephemeral });
    }
    reiniting.add(scope);
    await interaction.reply({
      content: `reinitializing memory for ${where}: re-downloading ${channels.length} channels...`,
      flags: ephemeral,
    });
    // the interaction token dies after 15 min, after that progress only goes to the logs
    const status = (content: string) => {
      log.info(`memory reinit ${scope}: ${content}`);
      interaction.editReply(content).catch(() => {});
    };

    void (async () => {
      try {
        const started = Date.now();
        const ids = channels.map((c) => c.id);
        const wiped = wipeArchive(ids);
        let crawled = 0;
        await Promise.all(
          channels.map((c) =>
            crawlChannel(c, true).then(() =>
              status(`re-downloading history: ${++crawled}/${channels.length} channels done`)
            )
          )
        );
        const msgs = latestMessages(ids, memoryCfg.rebuildMessages);
        const names = new Map(channels.map((c) => [c.id, 'name' in c && c.name ? c.name : 'dm']));
        const count = await rebuildNotes(
          scope,
          msgs,
          (id) => names.get(id) ?? 'channel',
          (part, parts) => status(`rebuilding notes from ${msgs.length} messages: part ${part}/${parts}`)
        );
        const mins = Math.round((Date.now() - started) / 60_000);
        const done = `memory reinit for ${where} done in ${mins}m: dropped ${wiped} archived messages, re-downloaded ${channels.length} channels, wrote ${count} notes from the last ${msgs.length} messages`;
        log.info(done);
        await interaction.editReply(done).catch(() => interaction.user.send(done).catch(() => {}));
      } catch (error) {
        log.error(`memory reinit ${scope} failed`, error);
        interaction.editReply('reinit blew up, check the logs').catch(() => {});
      } finally {
        reiniting.delete(scope);
      }
    })();
  },
};

export const commands: Record<
  string,
  {
    data: { name: string; toJSON(): unknown };
    execute: (i: ChatInputCommandInteraction) => Promise<unknown>;
  }
> = { mode, safety, shutup, ping, memory };
