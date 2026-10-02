import { BLUEPRINT_VERSION, EVERYONE } from '../constants.js';

/**
 * MiningFools server structure.
 *
 * The guild is being repurposed from "Valheim Pomp" around the MiningFools game
 * project, so this is the default blueprint.
 *
 * Design notes
 * ------------
 * - Category names carry emoji. Name matching is exact (case-insensitive), so an
 *   existing category called `MININGFOOLS` will NOT match `⛏️ MININGFOOLS` - the
 *   planner would create the new one and preserve the old. See the conflict
 *   notes in the Phase 2B report.
 * - Only one permission rule is applied by default: `#duyurular` is read-only
 *   for @everyone. It is the only rule that needs no custom role to exist, so
 *   the default plan creates no roles and can be applied to any server.
 * - Bot and integration roles (Jockie Music and friends) are managed by Discord
 *   and are excluded from snapshots entirely, so they are never touched.
 * - Nothing here is private, so no existing member loses access to a channel.
 */

/** Text categories that make up the project discussion areas. */
export const CATEGORIES = Object.freeze([
  { key: 'miningfools', name: '⛏️ MININGFOOLS' },
  { key: 'oyun-dunyasi', name: '🌍 OYUN DÜNYASI' },
  { key: 'gameplay', name: '🎮 GAMEPLAY' },
  { key: 'gelistirme', name: '🛠️ GELİŞTİRME' },
  { key: 'tasarim', name: '🎨 TASARIM' },
  { key: 'ses', name: '🔊 SES' },
  { key: 'firsatlar', name: '🎁 FIRSATLAR' },
  { key: 'muzik', name: '🎵 MÜZİK' },
  { key: 'eglence', name: '🎉 EĞLENCE' },
]);

export const CHANNELS = Object.freeze([
  /* ⛏️ MININGFOOLS ------------------------------------------------------- */
  {
    key: 'genel',
    name: 'genel',
    type: 'text',
    category: 'miningfools',
    topic: 'MiningFools hakkında genel sohbet.',
  },
  {
    key: 'duyurular',
    name: 'duyurular',
    type: 'text',
    category: 'miningfools',
    topic: 'Oyun ve proje duyuruları.',
    // The single default permission rule. Expanded by permissions.js into an
    // @everyone overwrite: view and read history allowed, sending denied.
    readOnly: true,
  },
  {
    key: 'fikirler',
    name: 'fikirler',
    type: 'text',
    category: 'miningfools',
    topic: 'Öneriler, fikirler ve geri bildirimler.',
  },
  {
    key: 'pompai',
    name: 'pompai',
    type: 'text',
    category: 'miningfools',
    topic: 'PompAI ile sohbet. /ask ile soru sor, /clear ile geçmişini temizle.',
    // Public: no overwrites. This is the one channel where /ask answers openly
    // in the open. AI answers are public in every channel (AI_RESPONSE_VISIBILITY).
  },

  /* 🌍 OYUN DÜNYASI ------------------------------------------------------ */
  {
    key: 'maden',
    name: 'maden',
    type: 'text',
    category: 'oyun-dunyasi',
    topic: 'Madencilik mekanikleri, cevherler ve kaynaklar.',
  },
  {
    key: 'ada',
    name: 'ada',
    type: 'text',
    category: 'oyun-dunyasi',
    topic: 'Ada dünyası, keşif ve harita.',
  },
  {
    key: 'marketler',
    name: 'marketler',
    type: 'text',
    category: 'oyun-dunyasi',
    topic: 'Marketler, ticaret ve alım-satım.',
  },
  {
    key: 'iskele-ve-tekne',
    name: 'iskele-ve-tekne',
    type: 'text',
    category: 'oyun-dunyasi',
    topic: 'İskele, tekne ve deniz araçları.',
  },

  /* 🎮 GAMEPLAY ---------------------------------------------------------- */
  {
    key: 'karakter',
    name: 'karakter',
    type: 'text',
    category: 'gameplay',
    topic: 'Karakter gelişimi, yetenekler ve sınıflar.',
  },
  {
    key: 'ekonomi',
    name: 'ekonomi',
    type: 'text',
    category: 'gameplay',
    topic: 'Oyun içi ekonomi, para birimi ve denge.',
  },
  {
    key: 'ilerleme',
    name: 'ilerleme',
    type: 'text',
    category: 'gameplay',
    topic: 'İlerleme sistemi, seviyeler ve başarımlar.',
  },

  /* 🛠️ GELİŞTİRME ------------------------------------------------------- */
  { key: 'unity', name: 'unity', type: 'text', category: 'gelistirme', topic: 'Unity motoru, sahne ve prefab notları.' },
  { key: 'kod', name: 'kod', type: 'text', category: 'gelistirme', topic: 'Kod, mimari ve pull request tartışmaları.' },
  { key: 'buglar', name: 'buglar', type: 'text', category: 'gelistirme', topic: 'Hata bildirimleri ve takibi.' },
  {
    key: 'test-build',
    name: 'test-build',
    type: 'text',
    category: 'gelistirme',
    topic: 'Test sürümleri ve geri bildirim.',
  },
  {
    key: 'performans',
    name: 'performans',
    type: 'text',
    category: 'gelistirme',
    topic: 'Optimizasyon, FPS ve profil çıkarma.',
  },

  /* 🎨 TASARIM ----------------------------------------------------------- */
  { key: 'assetler', name: 'assetler', type: 'text', category: 'tasarim', topic: '3B modeller, dokular ve hazır varlıklar.' },
  { key: 'gorseller', name: 'gorseller', type: 'text', category: 'tasarim', topic: 'Konsept çizimler ve görseller.' },
  { key: 'ui-ux', name: 'ui-ux', type: 'text', category: 'tasarim', topic: 'Arayüz ve kullanıcı deneyimi.' },
  {
    key: 'ses-muzik',
    name: 'ses-muzik',
    type: 'text',
    category: 'tasarim',
    topic: 'Oyun içi ses efektleri ve müzik tasarımı.',
  },

  /* 🔊 SES ---------------------------------------------------------------- */
  /* 🎁 FIRSATLAR ---------------------------------------------------------- */
  {
    key: 'bedava-oyunlar',
    name: 'bedava-oyunlar',
    type: 'text',
    category: 'firsatlar',
    topic: 'Ücretsiz oyun duyuruları (Epic + Steam). /ucretsiz ile hemen bak.',
    // Public, and the monitor posts here. Announcements carry no mentions, so
    // nobody is pinged by a giveaway.
  },

  /* 🎵 MÜZİK -------------------------------------------------------------- */
  {
    key: 'muzik-istek',
    name: 'muzik-istek',
    type: 'text',
    category: 'muzik',
    topic: 'Şarkı adını yaz, PompAI çalsın. Komut gerekmez.',
    // The only channel where a bare song name triggers playback.
  },
  { key: 'muzik-odasi', name: 'Müzik Odası', type: 'voice', category: 'muzik' },

  /* 🎉 EĞLENCE ------------------------------------------------------------- */
  {
    key: 'eglence',
    name: 'eglence',
    type: 'text',
    category: 'eglence',
    topic: 'Kazı, günlük kasa, parti oyunları. /kaz ile başla.',
    // Public, like every other fun surface: the games are social, and the
    // commands work in any channel anyway. No roles, no overwrites.
  },

  /* 🔊 SES ---------------------------------------------------------------- */
  { key: 'ses-miningfools', name: 'MiningFools', type: 'voice', category: 'ses' },
  { key: 'ses-gelistirme', name: 'Geliştirme Odası', type: 'voice', category: 'ses' },
  { key: 'ses-test', name: 'Test Odası', type: 'voice', category: 'ses' },
]);

/**
 * Roles proposed for the repurposed server.
 *
 * NOT part of the default blueprint. The spec defined channels and categories
 * only, and creating roles on a server that already has an equivalent set would
 * produce near-duplicates (e.g. both "Yönetici" and an existing "Admin"). Opt in
 * with `includeRoles: true` once the existing role list is known.
 */
export const PROPOSED_ROLES = Object.freeze([
  {
    key: 'kurucu',
    name: 'Kurucu',
    color: '#c0392b',
    hoist: true,
    mentionable: true,
    permissions: ['ViewChannel', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog', 'ManageMessages'],
  },
  {
    key: 'yonetici',
    name: 'Yönetici',
    color: '#e67e22',
    hoist: true,
    mentionable: true,
    permissions: ['ViewChannel', 'KickMembers', 'ModerateMembers', 'ManageMessages', 'ViewAuditLog'],
  },
  {
    key: 'moderator',
    name: 'Moderatör',
    color: '#e91e63',
    hoist: true,
    mentionable: true,
    permissions: ['ViewChannel', 'ModerateMembers', 'ManageMessages', 'ViewAuditLog'],
  },
  {
    key: 'gelistirici',
    name: 'Geliştirici',
    color: '#3498db',
    hoist: true,
    mentionable: true,
    permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'],
  },
  {
    key: 'tasarimci',
    name: 'Tasarımcı',
    color: '#9b59b6',
    hoist: false,
    mentionable: true,
    permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'],
  },
  {
    key: 'testci',
    name: 'Testçi',
    color: '#1abc9c',
    hoist: false,
    mentionable: true,
    permissions: ['ViewChannel', 'SendMessages', 'AttachFiles', 'ReadMessageHistory'],
  },
  {
    key: 'oyuncu',
    name: 'Oyuncu',
    color: '#2ecc71',
    hoist: false,
    mentionable: true,
    permissions: ['ViewChannel', 'SendMessages', 'AddReactions', 'ReadMessageHistory'],
  },
]);

/**
 * Optional music additions.
 *
 * `#muzik` gives Jockie Music a text channel to read commands from, and the
 * matching voice channel gives it somewhere to play. Both are left open to
 * @everyone, so no existing bot permission needs to change for this to work.
 */
export const MUSIC_CHANNELS = Object.freeze([
  {
    key: 'muzik',
    name: 'muzik',
    type: 'text',
    category: 'miningfools',
    topic: 'Müzik komutları (Jockie Music).',
  },
  { key: 'ses-muzik-oda', name: 'Müzik', type: 'voice', category: 'ses' },
]);

/**
 * @param {object} [options]
 * @param {boolean} [options.includeMusic] Add the optional #muzik channels.
 * @param {boolean} [options.includeRoles] Add PROPOSED_ROLES to the blueprint.
 * @param {object[]} [options.roles] Explicit role list, overriding either.
 * @param {object[]} [options.categories]
 * @param {object[]} [options.channels]
 */
export function createMiningFoolsBlueprint({
  includeMusic = false,
  includeRoles = false,
  roles,
  categories,
  channels,
} = {}) {
  const resolvedChannels = channels ?? [
    ...CHANNELS,
    ...(includeMusic ? MUSIC_CHANNELS : []),
  ];
  const resolvedRoles = roles ?? (includeRoles ? PROPOSED_ROLES : []);

  return {
    version: BLUEPRINT_VERSION,
    key: 'miningfools',
    title: 'MiningFools',
    roles: structuredClone(resolvedRoles),
    categories: structuredClone(categories ?? CATEGORIES),
    channels: structuredClone(resolvedChannels),
  };
}
