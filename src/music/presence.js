/**
 * Whether PompMusic is in a voice channel, and whether it should move.
 *
 * PompMusic is summoned once and then stays. It is never moved automatically,
 * and a random member cannot hijack it into another room. These are the rules
 * that decide that, kept pure so every branch is testable without a gateway.
 *
 * Summon (`/gel`):
 *   - the caller must be in a voice channel
 *   - already in that channel  -> say so, do nothing
 *   - in another channel       -> move ONLY if the caller has Manage Channels,
 *                                 or the channel PompMusic is sitting in is
 *                                 empty (nobody to disturb)
 *   - otherwise                -> refuse, and name where it is
 *
 * Leave (`/git`):
 *   - the caller must be in the active channel, or have Manage Channels
 */

/** Outcomes a caller acts on. */
export const SUMMON = Object.freeze({
  JOIN: 'join',
  ALREADY: 'already',
  MOVE: 'move',
  REFUSE: 'refuse',
});

export const LEAVE = Object.freeze({
  ALLOW: 'allow',
  REFUSE: 'refuse',
});

/** Every line PompMusic says about where it is. */
export const PRESENCE_TEXTS = Object.freeze({
  NOT_IN_VOICE: '🎧 Önce bir ses kanalına katıl.',
  arrived: (channel) => `🎵 PompMusic "${channel}" kanalına geldi.`,
  already: (channel) => `🎵 PompMusic zaten "${channel}" kanalında.`,
  inUse: (channel) => `🎧 PompMusic şu anda "${channel}" kanalında kullanılıyor.`,
  needSummon: "🎧 Önce bir ses kanalına girip /gel ile PompMusic'i çağır.",
  wrongChannel: (channel) => `🎧 Şarkı eklemek için PompMusic'in bulunduğu "${channel}" kanalına katıl.`,
  left: '👋 PompMusic kanaldan ayrıldı ve sıra temizlendi.',
  nothingToLeave: 'PompMusic şu anda bir ses kanalında değil.',
  leftNotPermitted: '⛔ Bunu yalnızca kanaldaki üyeler veya yöneticiler yapabilir.',
});

/**
 * Decides what `/gel` should do.
 *
 * The caller resolves the member's voice channel once, through
 * `resolveMemberVoiceChannel`, and passes the id in. These functions never
 * look at `member.voice` themselves - that lookup is wrong often enough in
 * real Discord that it must exist in exactly one place.
 *
 * @param {object} options
 * @param {string|null} options.memberChannelId Already-resolved voice channel.
 * @param {object|null} options.session
 * @param {string|null} [options.currentChannelName] Name of the channel PompMusic occupies.
 * @param {boolean} [options.currentChannelEmpty] Whether that channel has no humans in it.
 * @param {boolean} [options.hasManageChannels]
 * @param {string|null} [options.requestedChannelName]
 * @returns {{ action: string, reason: string|null, message: string|null }}
 */
export function evaluateSummon({
  memberChannelId,
  session,
  currentChannelName = null,
  currentChannelEmpty = false,
  hasManageChannels = false,
  requestedChannelName = null,
}) {
  if (!memberChannelId) {
    return refuse(SUMMON.REFUSE, 'not-in-voice', PRESENCE_TEXTS.NOT_IN_VOICE);
  }

  const active = session && !session.destroyed ? session : null;
  const label = requestedChannelName ?? 'ses kanalı';

  if (!active) {
    return { action: SUMMON.JOIN, reason: null, message: PRESENCE_TEXTS.arrived(label) };
  }

  if (active.voiceChannelId === memberChannelId) {
    return { action: SUMMON.ALREADY, reason: 'already-there', message: PRESENCE_TEXTS.already(currentChannelName ?? label) };
  }

  // Moving is a disruption: someone is already listening where it is.
  if (hasManageChannels || currentChannelEmpty) {
    return { action: SUMMON.MOVE, reason: null, message: PRESENCE_TEXTS.arrived(label) };
  }

  return refuse(SUMMON.REFUSE, 'in-use', PRESENCE_TEXTS.inUse(currentChannelName ?? 'başka bir kanal'));
}

/**
 * Decides whether a member may use the playback controls or leave.
 *
 * @param {object} options
 * @param {string|null} options.memberChannelId
 * @param {object|null} options.session
 * @param {boolean} [options.hasManageChannels]
 * @returns {{ ok: boolean, reason: string|null, message: string|null }}
 */
export function evaluateActiveMember({ memberChannelId, session, hasManageChannels = false }) {
  const active = session && !session.destroyed ? session : null;
  if (!active) {
    return { ok: false, reason: 'no-session', message: PRESENCE_TEXTS.needSummon };
  }

  if (!memberChannelId) {
    return { ok: false, reason: 'not-in-voice', message: PRESENCE_TEXTS.NOT_IN_VOICE };
  }

  if (active.voiceChannelId === memberChannelId) return { ok: true, reason: null, message: null };
  if (hasManageChannels) return { ok: true, reason: null, message: null };

  return {
    ok: false,
    reason: 'wrong-channel',
    message: PRESENCE_TEXTS.wrongChannel(active.channelName ?? active.voiceChannelId),
  };
}

/**
 * Decides whether a member may send `/git`.
 *
 * Same rule as the controls: be in the channel, or be an administrator.
 *
 * @returns {{ ok: boolean, reason: string|null, message: string|null }}
 */
export function evaluateLeave({ memberChannelId, session, hasManageChannels = false }) {
  const active = session && !session.destroyed ? session : null;
  if (!active) {
    return { ok: false, reason: 'no-session', message: PRESENCE_TEXTS.nothingToLeave };
  }

  if (memberChannelId === active.voiceChannelId || hasManageChannels) {
    return { ok: true, reason: null, message: null };
  }
  return { ok: false, reason: 'not-permitted', message: PRESENCE_TEXTS.leftNotPermitted };
}

function refuse(action, reason, message) {
  return { action, reason, message };
}
