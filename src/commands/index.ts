import {
  type ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from 'discord.js';
import { resetTurns } from '../brain';
import { limits } from '../config';
import { env } from '../env';
import { pruneAll } from '../history';
import {
  type ResponseMode,
  type SafetyMode,
  type Scope,
  settings,
} from '../settings';

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

const forget = {
  data: new SlashCommandBuilder()
    .setName('forget')
    .setDescription('Wipe what gork remembers; he only knows messages from now on')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addStringOption((o) =>
      o
        .setName('scope')
        .setDescription('Where to wipe his memory (default: this channel)')
        .addChoices(
          { name: 'This channel', value: 'channel' },
          { name: 'Whole server', value: 'guild' },
          { name: 'Everywhere', value: 'global' }
        )
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!canEdit(interaction)) {
      return interaction.reply({ content: 'nice try', flags: ephemeral });
    }
    let scope = interaction.options.getString('scope') ?? 'channel';
    if (scope === 'guild' && !interaction.guildId) scope = 'channel';
    const { channelId, guildId } = interaction;
    // the command's own id: discord made it, so everything before it is older by discord's clock
    const upTo = interaction.id;
    if (scope === 'global') settings.forget(null, null, upTo);
    else if (scope === 'guild') settings.forget('guild', guildId!, upTo);
    else settings.forget('channel', channelId, upTo);
    pruneAll();
    resetTurns((c, g) => scope === 'global' || (scope === 'guild' ? g === guildId : c === channelId));
    const where = scope === 'global' ? 'everywhere' : scope === 'guild' ? 'this server' : 'this channel';
    return interaction.reply({
      content: `wiped gork's memory for ${where}. he only remembers messages from now on`,
      flags: ephemeral,
    });
  },
};

const ignore = {
  data: new SlashCommandBuilder()
    .setName('ignore')
    .setDescription('Turn gork off for someone: he stops seeing and answering them')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Make gork ignore someone')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addBooleanOption((o) => o.setName('everywhere').setDescription('In every server, not just this one'))
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Let gork talk to someone again')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addBooleanOption((o) => o.setName('everywhere').setDescription('Remove the everywhere ignore too'))
    )
    .addSubcommand((s) => s.setName('list').setDescription('Who gork is ignoring')),
  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: 'this only works in a server', flags: ephemeral });
    if (!canEdit(interaction)) {
      return interaction.reply({ content: 'nah only my owner gets to touch that', flags: ephemeral });
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const { everywhere, server } = settings.ignoredIn(guildId);
      const fmt = (ids: string[]) => (ids.length ? ids.map((id) => `<@${id}>`).join(', ') : 'nobody');
      return interaction.reply({
        content: `ignored in this server: ${fmt(server)}\nignored everywhere: ${fmt(everywhere)}`,
        flags: ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    const user = interaction.options.getUser('user', true);
    const everywhere = interaction.options.getBoolean('everywhere') ?? false;
    if (sub === 'add') {
      if (user.id === env.DISCORD_OWNER_ID) {
        return interaction.reply({ content: "can't ignore my owner", flags: ephemeral });
      }
      if (user.id === interaction.client.user.id) {
        return interaction.reply({ content: 'i cant ignore myself', flags: ephemeral });
      }
      settings.setIgnored(everywhere ? null : guildId, user.id, true);
      pruneAll();
      return interaction.reply({
        content: `gork is ignoring <@${user.id}> ${everywhere ? 'everywhere' : 'in this server'}. he won't see or answer them`,
        flags: ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    settings.setIgnored(guildId, user.id, false);
    if (everywhere) settings.setIgnored(null, user.id, false);
    const still = settings.isIgnored(guildId, user.id);
    return interaction.reply({
      content: still
        ? `removed the server ignore, but <@${user.id}> is still ignored everywhere. run it again with everywhere: true`
        : `gork can see <@${user.id}> again (from new messages on)`,
      flags: ephemeral,
      allowedMentions: { parse: [] },
    });
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

export const commands: Record<
  string,
  {
    data: { name: string; toJSON(): unknown };
    execute: (i: ChatInputCommandInteraction) => Promise<unknown>;
  }
> = { mode, safety, shutup, forget, ignore, ping };
