import { BotError } from '../utils/errors.js';

/**
 * Read-only guard.
 *
 * Wraps a live discord.js object so that *calling* a mutating method throws.
 *
 * The trap only intercepts the call, never the read: property access returns the
 * underlying value untouched, so getters and identity behave exactly as they
 * would without the guard. That is what makes it safe to wrap a real guild - it
 * cannot break a legitimate read.
 *
 * Scope: the object it is given, plus (via `guardGuild`) the guild's managers.
 * That covers the realistic accidents. It does not deep-wrap every cached
 * channel or role, so `someChannel.edit()` would still be callable - the static
 * assertion in `npm run check` covers that case.
 *
 * This module imports nothing from the setup pipeline, so both the snapshot
 * reader and the live session can use it without creating an import cycle.
 */

/**
 * Methods that would change Discord state.
 *
 * A denylist of exact names: the guard throws only when one is *called*, so a
 * name appearing here can never interfere with a legitimate read.
 */
export const MUTATING_METHODS = Object.freeze([
  'create',
  'edit',
  'delete',
  'set',
  'clear',
  'upsert',
  'bulkDelete',
  'setName',
  'setTopic',
  'setParent',
  'setPosition',
  'setPermissions',
  'setColor',
  'setHoist',
  'setMentionable',
  'setNSFW',
  'setRateLimitPerUser',
  'setUserLimit',
  'setBitrate',
  'setInvitable',
  'setIcon',
  'setOwner',
  'setAFKChannel',
  'setSystemChannel',
  'setRulesChannel',
  'setPublicUpdatesChannel',
  'setPreferredLocale',
  'setVerificationLevel',
  'setExplicitContentFilter',
  'setDefaultMessageNotifications',
  'setMFALevel',
  'setFeatures',
  'disconnect',
  'ban',
  'kick',
  'timeout',
  'addRoles',
  'removeRoles',
  'setNickname',
  'send',
]);

const MUTATING = new Set(MUTATING_METHODS);

/** Managers on a guild that expose mutating methods. */
const GUARDED_MANAGERS = Object.freeze(['roles', 'channels', 'members', 'bans', 'invites', 'emojis', 'stickers']);

const guards = new WeakMap();

/**
 * @param {object} target
 * @param {string} label
 * @returns {object} guarded view of `target`
 */
export function guardReadOnly(target, label = 'guild') {
  if (target === null || typeof target !== 'object') return target;
  if (guards.has(target)) return guards.get(target);

  const guarded = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'string' && MUTATING.has(property)) {
        return () => {
          throw new BotError(
            `Refusing to call "${label}.${property}()": snapshots are read-only. ` +
              'Writing to Discord belongs to the apply pipeline, not to the observer.',
            { code: 'SNAPSHOT_READ_ONLY_VIOLATION', details: { label, method: property } },
          );
        };
      }

      const value = Reflect.get(object, property, receiver);
      // Return the guarded view for anything already wrapped, so a manager
      // registered by `guardGuild` is actually handed out through the proxy.
      if (value !== null && typeof value === 'object' && guards.has(value)) {
        return guards.get(value);
      }
      return value;
    },
  });

  guards.set(target, guarded);
  return guarded;
}

/**
 * Guards a guild and the managers hanging off it.
 * @param {import('discord.js').Guild} guild
 */
export function guardGuild(guild) {
  const guarded = guardReadOnly(guild, 'guild');
  for (const manager of GUARDED_MANAGERS) {
    const value = Reflect.get(guild, manager);
    if (value !== null && typeof value === 'object') {
      guardReadOnly(value, `guild.${manager}`);
    }
  }
  return guarded;
}
