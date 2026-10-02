import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { formatNumber } from './levels.js';
import { describeItem } from './loot.js';
import { PARTY_ACTIONS, partyComponentId } from './party.js';

/**
 * Turkish presentation for the fun layer.
 *
 * Every user-facing string lives here, so wording can change without touching a
 * game rule and a test can assert the numbers without parsing an embed.
 */

export const FUN_COLOR = 0x8b5e34;
export const WIN_COLOR = 0x57f287;
export const LOSS_COLOR = 0xed4245;
export const PARTY_COLOR = 0xeb459e;

/**
 * Uppercases a name the way Turkish does it.
 *
 * The locale-aware form is correct HERE and wrong in comparisons: it maps `i`
 * to `İ` (dotted), which is what a reader expects in `KEMAL'İN`. Matching code
 * elsewhere in this project deliberately uses plain `toLowerCase` for the
 * opposite reason.
 *
 * @param {string} value
 */
export function turkishUpper(value) {
  try {
    return String(value ?? '').toLocaleUpperCase('tr');
  } catch {
    return String(value ?? '').toUpperCase();
  }
}

/** `+45 XP` / `+120 Altın`, or null when the amount is zero. */
function awardLines({ coins, xp }) {
  const lines = [];
  if (xp > 0) lines.push(`⭐ +${formatNumber(xp)} XP`);
  if (coins > 0) lines.push(`🪙 +${formatNumber(coins)} Altın`);
  return lines;
}

function levelLine(progress) {
  return `Seviye: ${progress.level} — ${progress.title}`;
}

/**
 * The public mining result.
 *
 * @param {object} result From `mine()`.
 * @param {string|null} displayName
 */
export function buildMineEmbed(result, displayName = null) {
  const { outcome, coins, xp, progress, leveledUp } = result;

  const found =
    outcome.key === 'gocuk'
      ? `${outcome.emoji} ${outcome.label}! Tünel üstüne çöktü, elin boş döndün.`
      : `${outcome.emoji} ${outcome.label} buldun!`;

  const lines = [found, '', ...awardLines({ coins, xp })];

  if (result.itemKey) lines.push(`${describeItem(result.itemKey)} envanterine eklendi.`);
  if (leveledUp) lines.push('', `🎉 Seviye atladın! **Seviye ${progress.level} — ${progress.title}**`);
  else lines.push('', levelLine(progress));

  const embed = new EmbedBuilder()
    .setColor(outcome.key === 'gocuk' ? LOSS_COLOR : outcome.rare ? WIN_COLOR : FUN_COLOR)
    .setTitle('⛏️ KAZI SONUCU')
    .setDescription(lines.join('\n'));

  if (displayName) embed.setFooter({ text: displayName });
  return embed;
}

/** "⏳ 4 dk 12 sn sonra tekrar kazabilirsin." */
export function cooldownText(remainingSeconds) {
  const total = Math.max(0, Math.ceil(remainingSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  const parts = [];
  if (minutes > 0) parts.push(`${minutes} dk`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} sn`);
  return `⏳ Kazman hazır değil. ${parts.join(' ')} sonra tekrar dene.`;
}

/** "⏳ 3 sa 20 dk sonra..." - the daily cooldown is hours, not minutes. */
export function dailyCooldownText(remainingSeconds, streak) {
  const total = Math.max(0, Math.ceil(remainingSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.ceil((total % 3600) / 60);

  const parts = [];
  if (hours > 0) parts.push(`${hours} sa`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes} dk`);

  const suffix = streak > 0 ? ` Serin: **${streak} gün**.` : '';
  return `⏳ Kasayı bugün zaten açtın. ${parts.join(' ')} sonra tekrar gel.${suffix}`;
}

/** The daily chest result. */
export function buildDailyEmbed(result, displayName = null) {
  const lines = [...awardLines({ coins: result.coins, xp: result.xp })];

  if (result.itemKey) lines.push(`${describeItem(result.itemKey)} ×1`);

  lines.push('', `🔥 Seri: ${result.streak} gün`);
  if (result.streakChange === 'reset') lines.push('💔 Seri sıfırlandı, yeniden başlıyorsun.');
  if (result.leveledUp) lines.push(`🎉 Seviye atladın! **Seviye ${result.progress.level} — ${result.progress.title}**`);

  const embed = new EmbedBuilder()
    .setColor(FUN_COLOR)
    .setTitle('🎁 GÜNLÜK KASA')
    .setDescription(lines.join('\n'));

  if (displayName) embed.setFooter({ text: displayName });
  return embed;
}

/** The mining profile. */
export function buildProfileEmbed(profile) {
  const name = turkishUpper(profile.displayName ?? profile.userId);
  const embed = new EmbedBuilder()
    .setColor(FUN_COLOR)
    .setTitle(`⛏️ ${name} MADENCİ PROFİLİ`)
    .addFields(
      { name: 'Seviye', value: String(profile.level), inline: true },
      { name: 'Unvan', value: profile.title, inline: true },
      { name: 'XP', value: formatNumber(profile.xp), inline: true },
      { name: 'Altın', value: formatNumber(profile.coins), inline: true },
      { name: 'Kazı', value: formatNumber(profile.mines), inline: true },
      { name: 'Nadir buluntu', value: formatNumber(profile.rareFinds), inline: true },
      { name: 'Günlük seri', value: `${profile.streak} gün`, inline: true },
    );

  if (!profile.maxLevel) {
    embed.addFields({
      name: 'Sonraki seviye',
      value: `${formatNumber(profile.progress.toNextLevel)} XP kaldı`,
      inline: true,
    });
  }

  if (!profile.exists) {
    embed.setFooter({ text: 'Henüz hiç kazmadın — /kaz ile başla.' });
  }
  return embed;
}

/** The inventory, rarest first. */
export function buildInventoryEmbed(profile) {
  const name = turkishUpper(profile.displayName ?? profile.userId);
  const embed = new EmbedBuilder().setColor(FUN_COLOR).setTitle(`🎒 ENVANTER — ${name}`);

  if (profile.inventory.length === 0) {
    embed.setDescription('Envanterin boş. `/kaz` ile kazmaya başla.');
    return embed;
  }

  embed.setDescription(
    profile.inventory.map((entry) => `${entry.label} ×${formatNumber(entry.quantity)}`).join('\n'),
  );
  return embed;
}

const MEDALS = ['🥇', '🥈', '🥉'];

/** The guild leaderboard. */
export function buildLeaderboardEmbed(rows, guildName = null) {
  const embed = new EmbedBuilder()
    .setColor(FUN_COLOR)
    .setTitle(`🏆 LİDERLİK${guildName ? ` — ${guildName}` : ''}`);

  if (rows.length === 0) {
    embed.setDescription('Bu sunucuda henüz kimse kazmadı. İlk olan sen ol!');
    return embed;
  }

  embed.setDescription(
    rows
      .map((row) => {
        const medal = MEDALS[row.rank - 1] ?? `**${row.rank}.**`;
        const name = row.displayName ?? row.userId;
        return `${medal} ${name} — Seviye ${row.level} — ${formatNumber(row.xp)} XP`;
      })
      .join('\n'),
  );
  embed.setFooter({ text: 'Sıralama XP\'ye göre; eşitlikte Altın\'a bakılır.' });
  return embed;
}

/** The party round: the question plus its two controls. */
export function buildPartyPayload(session) {
  const embed = new EmbedBuilder()
    .setColor(PARTY_COLOR)
    .setTitle(`${session.meta.emoji} ${session.meta.title}`)
    .setDescription(session.question);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(partyComponentId(PARTY_ACTIONS.NEW, session.id))
      .setLabel('Yeni Soru')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(partyComponentId(PARTY_ACTIONS.END, session.id))
      .setLabel('Bitir')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

/** Strips the controls, leaving the question readable after the round ends. */
export function retiredPartyPayload(session) {
  const payload = buildPartyPayload(session);
  return { embeds: payload.embeds, components: [] };
}

/** A fortune. */
export function buildFortuneEmbed(fortune, displayName = null) {
  const embed = new EmbedBuilder().setColor(PARTY_COLOR).setTitle('🔮 PompAI Falı').setDescription(fortune);
  if (displayName) embed.setFooter({ text: displayName });
  return embed;
}

/** The nickname announcement. */
export function nicknameText(displayName, nickname) {
  return `🏷️ **${displayName}** artık **${nickname}** olarak biliniyor.`;
}
