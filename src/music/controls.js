import { CONTROL_IDS, SELECT_PREFIX } from './messages.js';

/**
 * Control authorization.
 *
 * Pure decision functions over a member, a session and the action being asked
 * for, so every rule can be tested without a gateway.
 *
 * Rules:
 *   - every control requires the member to be in the *active* voice channel.
 *     Someone typing from another channel cannot steer this session.
 *   - skip and the cosmetic controls are open to anyone in that channel.
 *   - stop is destructive, so it needs the requester, Manage Channels, or the
 *     configured DJ role.
 */

export const CONTROL_ACTIONS = Object.freeze({
  PAUSE: 'pause',
  SKIP: 'skip',
  STOP: 'stop',
  SHUFFLE: 'shuffle',
  REPEAT: 'repeat',
  SELECT: 'select',
});

/** Stops require one of these, in addition to being in the channel. */
export const RESTRICTED_ACTIONS = Object.freeze([CONTROL_ACTIONS.STOP]);

const ID_TO_ACTION = Object.freeze(
  Object.fromEntries(Object.entries(CONTROL_IDS).map(([key, id]) => [id, key.toLowerCase()])),
);

/**
 * Extracts the action from a component customId.
 *
 * Simple controls are exact matches. The selection menu is `music:select:<id>`
 * and is handled by `parseSelectionId`; here it reports the `select` action.
 *
 * @param {string} customId
 * @returns {string|null}
 */
export function parseControlId(customId) {
  if (typeof customId !== 'string' || !customId.startsWith('music:')) return null;
  if (ID_TO_ACTION[customId]) return ID_TO_ACTION[customId];
  if (parseSelectionId(customId)) return CONTROL_ACTIONS.SELECT;
  return null;
}

/**
 * Extracts the request id from a selection customId.
 *
 * Discord snowflakes are digits only, so the shape is checked strictly: a
 * hand-crafted id cannot smuggle separators or a path into the cache key.
 *
 * @param {string} customId
 * @returns {string|null}
 */
export function parseSelectionId(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(SELECT_PREFIX)) return null;
  const requestId = customId.slice(SELECT_PREFIX.length);
  return /^\d{5,32}$/.test(requestId) ? requestId : null;
}

/**
 * Decides whether a member may choose from a pending selection.
 *
 * Stricter than the playback controls: only the person who asked may pick, and
 * they must still be in the voice channel the request came from. A candidate
 * list is one person's search, not a shared menu.
 *
 * @param {object} options
 * @param {string|null} options.memberId
 * @param {string|null} options.memberChannelId Already resolved via voice-state.js.
 * @param {object|null} options.entry Cached selection.
 * @param {object|null} options.session
 * @returns {{ ok: boolean, reason: string|null, message: string|null }}
 */
export function authorizeSelection({ member = null, memberId = null, memberChannelId = null, entry, session }) {
  if (!entry) {
    return deny('expired', '⌛ Bu arama zaman aşımına uğradı. Şarkı adını tekrar yaz.');
  }

  const id = memberId ?? member?.id ?? null;
  if (!id || id !== entry.userId) {
    return deny('not-requester', '⛔ Bu menüyü yalnızca şarkıyı isteyen kişi kullanabilir.');
  }

  if (!memberChannelId) {
    return deny('not-in-voice', '🎧 Önce bir ses kanalına katıl.');
  }
  if (memberChannelId !== entry.voiceChannelId) {
    return deny('wrong-channel', '🎧 Bu seçim için müzik odasında olmalısın.');
  }

  // A session need NOT exist yet. A menu can be the very first thing that
  // happens in a channel, and the entry already records which voice channel the
  // request came from - that is the binding, not a live session. Only an
  // existing session that has moved on invalidates the menu.
  if (session) {
    if (session.destroyed) {
      return deny('no-session', '⌛ Müzik oturumu sona erdi. Şarkı adını tekrar yaz.');
    }
    if (session.voiceChannelId !== entry.voiceChannelId) {
      return deny('voice-session-changed', '⌛ Ses oturumu değişti. Şarkı adını tekrar yaz.');
    }
  }

  return { ok: true, reason: null, message: null };
}

/** True when this customId belongs to the music subsystem. */
export function isMusicControl(customId) {
  return typeof customId === 'string' && customId.startsWith('music:');
}

/**
 * Decides whether a member may use a control.
 *
 * @param {object} options
 * @param {string} options.action
 * @param {string|null} options.memberChannelId Already resolved via voice-state.js.
 * @param {object|null} options.session
 * @param {string|null} [options.requesterId] Member id that started playback.
 * @param {string|null} [options.djRoleId] Configurable DJ role (unused today).
 * @param {number} [options.manageChannelsFlag] PermissionFlagsBits.ManageChannels.
 * @returns {{ ok: boolean, reason: string|null, message: string|null }}
 */
export function authorizeControl({
  action,
  member,
  memberChannelId,
  session,
  requesterId = null,
  djRoleId = null,
  manageChannelsFlag = null,
}) {
  if (!session || session.destroyed) {
    return deny('no-session', 'Şu anda çalan bir şey yok.');
  }

  if (!memberChannelId) {
    return deny('not-in-voice', '🎧 Önce bir ses kanalına katıl.');
  }
  if (memberChannelId !== session.voiceChannelId) {
    return deny('wrong-channel', '🎧 Bu kontroller için müzik odasında olmalısın.');
  }

  if (!RESTRICTED_ACTIONS.includes(action)) {
    return { ok: true, reason: null, message: null };
  }

  const memberId = member?.id ?? null;
  if (requesterId && memberId === requesterId) {
    return { ok: true, reason: null, message: null };
  }
  if (djRoleId && member?.roles?.cache?.has?.(djRoleId)) {
    return { ok: true, reason: null, message: null };
  }
  if (manageChannelsFlag !== null && member?.permissions?.has?.(manageChannelsFlag)) {
    return { ok: true, reason: null, message: null };
  }

  return deny('not-permitted', '⛔ Bunu yalnızca isteği açan kişi veya yöneticiler yapabilir.');
}

function deny(reason, message) {
  return { ok: false, reason, message };
}
