// index.js - SWEETSiEZ Moderation Bot (Option B with acknowledge-threads)
// Matches your original bot style: express + discord.js + REST + process.env config

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ---------- CONFIG ----------
const config = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  PORT: process.env.PORT || 3000,
  MOD_LOG_CHANNEL_ID: process.env.MOD_LOG_CHANNEL_ID,
  RULES_CHANNEL_ID: process.env.RULES_CHANNEL_ID,

  PREFIX: process.env.PREFIX || '-',

  ROLE_STAFF_ASSISTANT: process.env.ROLE_STAFF_ASSISTANT,
  ROLE_ASSISTANT_SUPERVISOR: process.env.ROLE_ASSISTANT_SUPERVISOR,
  ROLE_SUPERVISOR: process.env.ROLE_SUPERVISOR,
  ROLE_ASSISTANT_MANAGER: process.env.ROLE_ASSISTANT_MANAGER,
  ROLE_UNBAN: process.env.ROLE_UNBAN // role allowed to unban (above assistant manager)
};

if (!config.DISCORD_TOKEN || !config.DISCORD_CLIENT_ID) {
  console.error('ERROR: DISCORD_TOKEN and DISCORD_CLIENT_ID must be set as Replit secrets.');
  process.exit(1);
}
if (!config.MOD_LOG_CHANNEL_ID) {
  console.warn('WARN: MOD_LOG_CHANNEL_ID not set. Mod logs will be disabled.');
}
if (!config.RULES_CHANNEL_ID) {
  console.warn('WARN: RULES_CHANNEL_ID not set. Acknowledgement threads will fail until set.');
}

// ---------- Data persistence helpers ----------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json');
const CASES_FILE = path.join(DATA_DIR, 'cases.json');

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
      return JSON.parse(JSON.stringify(fallback));
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('Failed to load JSON:', filePath, err);
    return JSON.parse(JSON.stringify(fallback));
  }
}

function saveJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Failed to save JSON:', filePath, err);
  }
}

// initialize data stores
let warnings = loadJson(WARNINGS_FILE, []); // array of { id, userId, moderatorId, reason, timestamp }
let cases = loadJson(CASES_FILE, { nextCaseId: 1, records: [] }); // { nextCaseId, records: [] }

// Case helper
function nextCase(action, moderatorId, targetUserId, reason, extra = {}) {
  const caseId = cases.nextCaseId++;
  const record = {
    caseId,
    action,
    moderatorId,
    targetUserId,
    reason: reason || 'No reason provided',
    timestamp: new Date().toISOString(),
    extra
  };
  cases.records.push(record);
  saveJson(CASES_FILE, cases);
  return record;
}

// ---------- Express (health) ----------
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('SWEETSiEZ Moderation Bot is running!'));
app.listen(config.PORT, () => console.log(`Server running on port ${config.PORT}`));

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ---------- Permission helpers ----------
function getMemberLevel(member) {
  if (!member || !member.roles) return 0;
  const r = config;
  if (r.ROLE_ASSISTANT_MANAGER && member.roles.cache.has(r.ROLE_ASSISTANT_MANAGER)) return 4; // assistant manager+
  if (r.ROLE_SUPERVISOR && member.roles.cache.has(r.ROLE_SUPERVISOR)) return 3;
  if (r.ROLE_ASSISTANT_SUPERVISOR && member.roles.cache.has(r.ROLE_ASSISTANT_SUPERVISOR)) return 2;
  if (r.ROLE_STAFF_ASSISTANT && member.roles.cache.has(r.ROLE_STAFF_ASSISTANT)) return 1;
  return 0;
}

function checkCanModerate(issuerMember, targetMember, minLevelRequired) {
  if (!issuerMember) return { ok: false, reason: 'no_issuer' };
  // owner bypass
  if (issuerMember.guild && issuerMember.guild.ownerId === issuerMember.id) return { ok: true };

  const issuerLevel = getMemberLevel(issuerMember);
  if (issuerLevel < minLevelRequired) return { ok: false, reason: 'insufficient_level' };

  if (targetMember && issuerMember.roles.highest.position <= targetMember.roles.highest.position) {
    return { ok: false, reason: 'role_hierarchy' };
  }
  return { ok: true };
}

// ---------- Helper: mod log ----------
async function sendModLog(guild, record) {
  if (!config.MOD_LOG_CHANNEL_ID) return;
  try {
    const ch = await guild.channels.fetch(config.MOD_LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Mod Action: ${record.action}`)
      .addFields(
        { name: 'Case ID', value: `${record.caseId}`, inline: true },
        { name: 'Moderator', value: `<@${record.moderatorId}>`, inline: true },
        { name: 'Target', value: `<@${record.targetUserId}>`, inline: true },
        { name: 'Reason', value: record.reason, inline: false }
      )
      .setTimestamp(new Date(record.timestamp))
      .setColor(record.color || 0xff9900);
    if (record.extra) {
      Object.entries(record.extra).forEach(([k, v]) => {
        embed.addFields({ name: String(k), value: String(v), inline: true });
      });
    }
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to send mod log:', err);
  }
}

// ---------- Commands ----------
const commands = [
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('warnings').setDescription("List a user's warnings")
    .addUserOption(o => o.setName('user').setDescription('User to view').setRequired(true)),

  new SlashCommandBuilder().setName('clearwarns').setDescription("Clear a user's warnings")
    .addUserOption(o => o.setName('user').setDescription('User to clear').setRequired(true)),

  new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('tempban').setDescription('Temporarily ban a user (minutes)')
    .addUserOption(o => o.setName('user').setDescription('User to tempban').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member (minutes)')
    .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('untimeout').setDescription('Remove timeout from a member')
    .addUserOption(o => o.setName('user').setDescription('User to untimeout').setRequired(true)),

  new SlashCommandBuilder().setName('purge').setDescription('Bulk delete messages (2-100)')
    .addIntegerOption(o => o.setName('amount').setDescription('Amount 2-100').setRequired(true)),
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
(async () => {
  try {
    console.log('Registering moderation slash commands...');
    await rest.put(
      Routes.applicationCommands(config.DISCORD_CLIENT_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('Slash commands registered!');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
})();

// ---------- Warning helpers ----------
function addWarning(userId, moderatorId, reason) {
  const id = warnings.length ? Math.max(...warnings.map(w => w.id)) + 1 : 1;
  const warning = { id, userId, moderatorId, reason: reason || 'No reason', timestamp: new Date().toISOString() };
  warnings.push(warning);
  saveJson(WARNINGS_FILE, warnings);
  return warning;
}

function getWarningsFor(userId) {
  return warnings.filter(w => w.userId === userId);
}

function clearWarningsFor(userId) {
  const before = warnings.length;
  warnings = warnings.filter(w => w.userId !== userId);
  saveJson(WARNINGS_FILE, warnings);
  return before - warnings.length;
}

// ---------- Acknowledgement thread helper ----------
/**
 * Create a private thread in RULES channel and add only the punished user.
 * Returns the ThreadChannel or null.
 *
 * options:
 *  - guild: Guild
 *  - user: User (to add)
 *  - title: string
 *  - description: string
 *  - caseId: number
 *  - actionType: string
 *  - ackRemovesTimeout: boolean (if true, pressing ack will remove timeout)
 */
async function createAcknowledgementThread({ guild, user, title, description, caseId, actionType, ackRemovesTimeout = false }) {
  if (!config.RULES_CHANNEL_ID) {
    console.warn('RULES_CHANNEL_ID not set; cannot create acknowledgement thread.');
    return null;
  }
  try {
    const rulesChannel = await guild.channels.fetch(config.RULES_CHANNEL_ID).catch(() => null);
    if (!rulesChannel) {
      console.warn('Rules channel not found or bot lacks access.');
      return null;
    }

    // create private thread
    // type: 12 => PrivateThread
    const starter = await rulesChannel.send({ content: `<@${user.id}>` });
    const thread = await starter.startThread({
      name: `${actionType} • Case ${caseId}`,
      autoArchiveDuration: 60, // 1 hour
      type: 12, // private
      invitable: false
    });

    // Add the punished user to the private thread (bot is already there)
    await thread.members.add(user.id).catch(() => {});

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .addFields(
        { name: 'Case ID', value: `${caseId}`, inline: true },
        { name: 'Action', value: actionType, inline: true }
      )
      .setTimestamp();

    const ackButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ack_${caseId}_${ackRemovesTimeout ? '1' : '0'}`)
        .setLabel('Acknowledge Consequence')
        .setStyle(ButtonStyle.Primary)
    );

    await thread.send({ embeds: [embed], components: [ackButton] });

    return thread;
  } catch (err) {
    console.error('Failed to create acknowledgement thread:', err);
    return null;
  }
}

// ---------- Interaction handler ----------
client.once('ready', () => {
  console.log(`✅ Moderation Bot logged in as ${client.user.tag}`);
  client.user.setActivity('Moderation • Sweetsiez', { type: 'WATCHING' });
});

client.on('interactionCreate', async (interaction) => {
  try {
    // Button interactions for acknowledgement
    if (interaction.isButton()) {
      const customId = interaction.customId; // ack_CASEID_0 or ack_CASEID_1
      if (!customId.startsWith('ack_')) return;
      const parts = customId.split('_'); // ['ack','<caseId>','0|1']
      const caseId = Number(parts[1]);
      const ackRemovesTimeout = parts[2] === '1';

      const record = cases.records.find(r => r.caseId === caseId);
      if (!record) return interaction.reply({ content: 'Case not found.', ephemeral: true });

      // Only the punished user can ack
      if (interaction.user.id !== record.targetUserId) {
        return interaction.reply({ content: 'You are not the user this consequence applies to.', ephemeral: true });
      }

      // If ackRemovesTimeout true and the user still is in the guild, remove timeout
      if (ackRemovesTimeout) {
        try {
          const member = await interaction.guild.members.fetch(record.targetUserId).catch(() => null);
          if (member) {
            await member.timeout(null, `Acknowledged case ${caseId}`);
          }
        } catch (err) {
          console.error('Failed to remove timeout on ack:', err);
        }
      }

      // Delete the thread immediately
      try {
        const thr = interaction.channel;
        // Only delete if this is a thread
        if (thr?.isThread()) {
          await thr.delete().catch(() => {});
        } else {
          // fallback: respond and instruct user
          await interaction.reply({ content: 'Acknowledged; staff will remove your timeout if applicable.', ephemeral: true });
        }
      } catch (err) {
        console.error('Error deleting thread after ack:', err);
      }

      // Log acknowledgement as a case
      const ackCase = nextCase('Acknowledge', client.user.id, record.targetUserId, `User acknowledged case ${caseId}`, { acknowledgedCase: caseId });
      await sendModLog(interaction.guild, { ...ackCase, color: 0x00cc66 });

      // respond ephemerally if not deleted
      try { await interaction.followUp({ content: `✅ Acknowledged case ${caseId}.`, ephemeral: true }); } catch (e) {}
      return;
    }

    // Slash command flow
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply({ ephemeral: false });

    const commandName = interaction.commandName;
    const guild = interaction.guild;
    const issuer = interaction.member;

    // helper
    async function fetchTarget(userOptionName) {
      const u = interaction.options.getUser(userOptionName);
      if (!u) return { user: null, member: null };
      const member = await guild.members.fetch(u.id).catch(() => null);
      return { user: u, member };
    }

    // ---------- WARN ----------
    if (commandName === 'warn') {
      const { user: targetUser, member: targetMember } = await fetchTarget('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      const can = checkCanModerate(issuer, targetMember, 1);
      if (!can.ok) return interaction.editReply('❌ You do not have permission to warn this user.');

      // Apply a short timeout (10 minutes) so this is a "mute until ack" experience.
      const timeoutMs = 10 * 60 * 1000;
      try {
        if (targetMember) {
          await targetMember.timeout(timeoutMs, `Warn applied by ${issuer.id} - case pending acknowledgement`);
        }
      } catch (err) {
        console.warn('Could not apply timeout on warn:', err);
      }

      const warning = addWarning(targetUser.id, issuer.id, reason);
      const caseRecord = nextCase('Warn', issuer.id, targetUser.id, reason, { warningId: warning.id });
      await sendModLog(guild, { ...caseRecord, color: 0xffcc00 });

      // Create acknowledgement private thread in rules channel
      const thread = await createAcknowledgementThread({
        guild,
        user: targetUser,
        title: 'You have received a warning',
        description: `You were warned in **${guild.name}** for: ${reason}\nYou have been muted for 10 minutes or until you acknowledge. Press the button to acknowledge.`,
        caseId: caseRecord.caseId,
        actionType: 'Warn',
        ackRemovesTimeout: true // acknowledging removes timeout for warn
      });

      return interaction.editReply(`✅ Warned <@${targetUser.id}> (Case ${caseRecord.caseId}). A private acknowledgement thread has been opened in the rules channel.`);
    }

    // ---------- WARNINGS ----------
    if (commandName === 'warnings') {
      const target = interaction.options.getUser('user');
      const userWarnings = getWarningsFor(target.id);
      if (userWarnings.length === 0) return interaction.editReply(`${target.tag} has no warnings.`);

      const embed = new EmbedBuilder()
        .setTitle(`Warnings for ${target.tag}`)
        .setDescription(`Count: ${userWarnings.length}`)
        .setTimestamp();

      userWarnings.slice(-10).forEach(w => {
        embed.addFields({ name: `ID ${w.id} — ${new Date(w.timestamp).toLocaleString()}`, value: `By <@${w.moderatorId}> — ${w.reason}` });
      });

      return interaction.editReply({ embeds: [embed] });
    }

    // ---------- CLEARWARNS ----------
    if (commandName === 'clearwarns') {
      const { user: targetUser, member: targetMember } = await fetchTarget('user');

      const can = checkCanModerate(issuer, targetMember, 4); // assistant manager+
      if (!can.ok) return interaction.editReply('❌ You do not have permission to clear warnings.');

      const removed = clearWarningsFor(targetUser.id);
      const caseRecord = nextCase('ClearWarns', issuer.id, targetUser.id, `Cleared ${removed} warnings`);
      await sendModLog(guild, { ...caseRecord, color: 0x00cc66 });

      return interaction.editReply(`✅ Cleared ${removed} warnings for <@${targetUser.id}> (Case ${caseRecord.caseId}).`);
    }

    // ---------- KICK ----------
    if (commandName === 'kick') {
      const { user: targetUser, member: targetMember } = await fetchTarget('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      if (!targetMember) return interaction.editReply('❌ User not found in guild.');

      const can = checkCanModerate(issuer, targetMember, 3);
      if (!can.ok) return interaction.editReply('❌ You do not have permission to kick this user.');

      // DM the user about kick before kicking (some may have DMs off)
      try {
        await targetUser.send(`You were kicked from **${guild.name}** for: ${reason}`);
      } catch (err) { /* ignore */ }

      await targetMember.kick(reason).catch(err => {
        console.error('Kick error:', err);
        return interaction.editReply('❌ Failed to kick user (missing permissions?).');
      });

      const caseRecord = nextCase('Kick', issuer.id, targetUser.id, reason);
      await sendModLog(guild, { ...caseRecord, color: 0xff6600 });

      return interaction.editReply(`✅ Kicked <@${targetUser.id}> (Case ${caseRecord.caseId}).`);
    }

    // ---------- BAN ----------
    if (commandName === 'ban') {
      const { user: targetUser, member: targetMember } = await fetchTarget('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      const can = checkCanModerate(issuer, targetMember, 2);
      if (!can.ok) return interaction.editReply('❌ You do not have permission to ban this user.');

      // DM the user (ban/kick allowed to dm)
      try {
        await targetUser.send(`You were banned from **${guild.name}** for: ${reason}`);
      } catch (err) { /* ignore */ }

      await guild.members.ban(targetUser.id, { reason }).catch(err => {
        console.error('Ban error:', err);
        return interaction.editReply('❌ Failed to ban user (missing permissions?).');
      });

      const caseRecord = nextCase('Ban', issuer.id, targetUser.id, reason);
      await sendModLog(guild, { ...caseRecord, color: 0x990000 });

      return interaction.editReply(`✅ Banned <@${targetUser.id}> (Case ${caseRecord.caseId}).`);
    }

    // ---------- TEMPBAN ----------
    if (commandName === 'tempban') {
      const { user: targetUser, member: targetMember } = await fetchTarget('user');
      const minutes = interaction.options.getInteger('minutes');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      if (isNaN(minutes) || minutes <= 0) return interaction.editReply('❌ Invalid duration (minutes).');

      const can = checkCanModerate(issuer, targetMember, 2);
      if (!can.ok) return interaction.editReply('❌ You do not have permission to tempban this user.');

      // DM the user
      try {
        await targetUser.send(`You were temporarily banned from **${guild.name}** for ${minutes} minute(s): ${reason}`);
      } catch (err) { /* ignore */ }

      await guild.members.ban(targetUser.id, { reason }).catch(err => {
        console.error('Tempban ban error:', err);
        return interaction.editReply('❌ Failed to ban user (missing permissions?).');
      });

      const expiresAt = Date.now() + minutes * 60 * 1000;
      const caseRecord = nextCase('TempBan', issuer.id, targetUser.id, reason, { expiresAt });
      await sendModLog(guild, { ...caseRecord, color: 0xaa0000, extra: { ExpiresAt: new Date(expiresAt).toISOString() } });

      // schedule unban (non-persistent). Recommend persistent scheduler later.
      setTimeout(async () => {
        try {
          const g = await client.guilds.fetch(guild.id);
          await g.bans.remove(targetUser.id, 'Tempban expired');
          const unbanRecord = nextCase('AutoUnban', client.user.id, targetUser.id, 'Tempban expired');
          await sendModLog(g, { ...unbanRecord, color: 0x00aa00 });
        } catch (err) {
          console.error('Auto unban failed:', err);
        }
      }, minutes * 60 * 1000);

      return interaction.editReply(`✅ Tempbanned <@${targetUser.id}> for ${minutes} minute(s) (Case ${caseRecord.caseId}).`);
    }

    // ---------- TIMEOUT ----------
    if (commandName === 'timeout') {
      const { user: targetUser, member: targetMember } = await fetchTarget('user');
      const minutes = interaction.options.getInteger('minutes');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      if (!targetMember) return interaction.editReply('❌ User not found in guild.');
      if (isNaN(minutes) || minutes <= 0 || minutes > 28 * 24 * 60) return interaction.editReply('❌ Invalid duration (1 to 40320 minutes).');

      const can = checkCanModerate(issuer, targetMember, 3);
      if (!can.ok) return interaction.editReply('❌ You do not have permission to timeout this user.');

      const msDuration = minutes * 60 * 1000;
      await targetMember.timeout(msDuration, reason).catch(err => {
        console.error('Timeout error:', err);
        return interaction.editReply('❌ Failed to timeout user (missing permissions?).');
      });

      const caseRecord = nextCase('Timeout', issuer.id, targetUser.id, reason, { durationMinutes: minutes });
      await sendModLog(guild, { ...caseRecord, color: 0x9933ff });

      // Create acknowledgement thread; per your requirement: acknowledging does NOT untimeout
      const thread = await createAcknowledgementThread({
        guild,
        user: targetUser,
        title: 'You have been timed out',
        description: `You have been timed out in **${guild.name}** for ${minutes} minute(s): ${reason}\nAcknowledging will confirm you have read this but will NOT remove your timeout.`,
        caseId: caseRecord.caseId,
        actionType: 'Timeout',
        ackRemovesTimeout: false
      });

      return interaction.editReply(`✅ Timed out <@${targetUser.id}> for ${minutes} minute(s) (Case ${caseRecord.caseId}). A private acknowledgement thread has been opened in the rules channel.`);
    }

    // ---------- UNTIMEOUT ----------
    if (commandName === 'untimeout') {
      const { user: targetUser, member: targetMember } = await fetchTarget('user');
      if (!targetMember) return interaction.editReply('❌ User not found in guild.');

      const can = checkCanModerate(issuer, targetMember, 3);
      if (!can.ok) return interaction.editReply('❌ You do not have permission to remove timeout.');

      await targetMember.timeout(null, 'Timeout removed by staff').catch(err => {
        console.error('Untimeout error:', err);
        return interaction.editReply('❌ Failed to remove timeout (missing permissions?).');
      });

      const caseRecord = nextCase('RemoveTimeout', issuer.id, targetUser.id, 'Timeout removed by moderator');
      await sendModLog(guild, { ...caseRecord, color: 0x00ccff });

      try { await targetUser.send(`Your timeout in **${guild.name}** has been removed. Case ID: ${caseRecord.caseId}`); } catch {}

      return interaction.editReply(`✅ Removed timeout for <@${targetUser.id}> (Case ${caseRecord.caseId}).`);
    }

    // ---------- PURGE ----------
    if (commandName === 'purge') {
      const amount = interaction.options.getInteger('amount');
      if (!amount || amount < 2 || amount > 100) return interaction.editReply('❌ Amount must be between 2 and 100.');

      if (getMemberLevel(issuer) < 4 && !issuer.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.editReply('❌ You do not have permission to purge messages.');
      }

      const fetched = await interaction.channel.bulkDelete(amount, true).catch(err => {
        console.error('Bulk delete error:', err);
        return null;
      });

      const count = fetched?.size || 0;
      const caseRecord = nextCase('Purge', issuer.id, issuer.id, `Purged ${count} messages in ${interaction.channel.id}`, { channel: interaction.channel.id, deletedCount: count });
      await sendModLog(guild, { ...caseRecord, color: 0x666666 });

      return interaction.editReply(`✅ Purged ${count} messages.`);
    }

    return interaction.editReply('Unknown command.');
  } catch (err) {
    console.error('Command error:', err);
    try { await interaction.editReply('❌ An error occurred while processing the command.'); } catch (e) {}
  }
});

// ---------- Event logging (message delete/edit, member join/leave) ----------
client.on('messageDelete', async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;
    const ch = await message.guild.channels.fetch(config.MOD_LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setTitle('🗑️ Message Deleted')
      .addFields(
        { name: 'Author', value: `${message.author.tag} (${message.author.id})` },
        { name: 'Channel', value: `${message.channel}` }
      )
      .setTimestamp();
    if (message.content) embed.addFields({ name: 'Content', value: message.content });
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('messageDelete log error:', err);
  }
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  try {
    if (!oldMsg.guild || oldMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;
    const ch = await oldMsg.guild.channels.fetch(config.MOD_LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setTitle('✏️ Message Edited')
      .addFields(
        { name: 'Author', value: `${oldMsg.author.tag} (${oldMsg.author.id})` },
        { name: 'Channel', value: `${oldMsg.channel}` },
        { name: 'Before', value: oldMsg.content || '*embed/attachment*' },
        { name: 'After', value: newMsg.content || '*embed/attachment*' }
      )
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('messageUpdate log error:', err);
  }
});

client.on('guildMemberAdd', async (member) => {
  try {
    const ch = await member.guild.channels.fetch(config.MOD_LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setTitle('📥 Member Joined')
      .setDescription(`${member.user.tag} (${member.id})`)
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('guildMemberAdd log error:', err);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    const ch = await member.guild.channels.fetch(config.MOD_LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setTitle('📤 Member Left')
      .setDescription(`${member.user.tag} (${member.id})`)
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('guildMemberRemove log error:', err);
  }
});

// ---------- Login ----------
client.login(config.DISCORD_TOKEN);
