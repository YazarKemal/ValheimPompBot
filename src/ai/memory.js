/**
 * Lightweight conversation memory.
 *
 * Scope and limits, by design:
 *   - RAM only. Nothing is written to disk, and a restart starts empty.
 *   - Keyed by guild + channel + user, so one person's conversation can never
 *     appear in another's context, and the same person has separate histories
 *     in different channels.
 *   - Bounded twice over: a per-conversation message cap, and a cap on how many
 *     conversations are retained at all.
 *   - Only messages that passed through PompAI are ever stored. Nothing is read
 *     from Discord history.
 */

export const DEFAULT_HISTORY_MESSAGES = 10;
export const DEFAULT_MAX_CONVERSATIONS = 500;

/**
 * Longest single message retained. A provider may return far more than is
 * useful to replay, and the history is competing with the prompt for the same
 * token budget.
 */
export const MAX_STORED_MESSAGE_CHARS = 2000;

/**
 * Conversation store.
 *
 * Not a class with private state for its own sake: the store is passed around
 * explicitly through `ctx`, which keeps it trivially testable and makes the
 * "restart clears everything" property a matter of constructing a new one.
 */
export class ConversationMemory {
  /**
   * @param {object} [options]
   * @param {number} [options.maxMessages] Messages retained per conversation.
   * @param {number} [options.maxConversations] Conversations retained in total.
   */
  constructor({ maxMessages = DEFAULT_HISTORY_MESSAGES, maxConversations = DEFAULT_MAX_CONVERSATIONS } = {}) {
    if (!Number.isInteger(maxMessages) || maxMessages < 0) {
      throw new TypeError('maxMessages must be a non-negative integer');
    }
    if (!Number.isInteger(maxConversations) || maxConversations < 1) {
      throw new TypeError('maxConversations must be a positive integer');
    }

    this.maxMessages = maxMessages;
    this.maxConversations = maxConversations;
    /** @type {Map<string, Array<{role: string, content: string}>>} */
    this.conversations = new Map();
  }

  /**
   * Stable key for one conversation.
   *
   * Four independent axes, so nothing can bleed:
   *   namespace - which assistant is talking. `/ask` (MiningFools project help)
   *               and `/oyun` (general games help) must never share context.
   *   guildId   - identically named channels in different guilds stay apart.
   *   topic     - the channel for `/ask`, or the game for `/oyun`.
   *   userId    - one person's history is never another's.
   */
  static key({ namespace = 'chat', guildId = null, channelId = null, topic = null, userId = null } = {}) {
    const where = topic ?? channelId ?? 'unknown';
    return `${namespace}|${guildId ?? 'dm'}|${where}|${userId ?? 'unknown'}`;
  }

  /**
   * @param {{ guildId?: string|null, channelId?: string|null, userId?: string|null }} scope
   * @returns {Array<{role: string, content: string}>} a copy, safe to hand to a caller
   */
  history(scope) {
    const stored = this.conversations.get(ConversationMemory.key(scope));
    if (!stored) return [];
    return stored.map((message) => ({ ...message }));
  }

  /**
   * Appends messages and trims to the per-conversation cap.
   *
   * Empty messages are skipped, and overlong ones are truncated: the history
   * must respect the same cost limits as the prompt itself.
   *
   * @param {{ guildId?: string|null, channelId?: string|null, userId?: string|null }} scope
   * @param {...{role: string, content: string}} messages
   * @returns {number} how many messages the conversation now holds
   */
  append(scope, ...messages) {
    if (this.maxMessages === 0) return 0;

    const key = ConversationMemory.key(scope);
    const history = this.conversations.get(key) ?? [];

    for (const message of messages) {
      const content = String(message?.content ?? '').trim();
      if (content === '') continue;
      const role = message?.role === 'assistant' ? 'assistant' : 'user';
      history.push({
        role,
        content: content.length > MAX_STORED_MESSAGE_CHARS ? content.slice(0, MAX_STORED_MESSAGE_CHARS) : content,
      });
    }

    // Keep the most recent messages; older turns fall out of the window.
    const trimmed = history.length > this.maxMessages ? history.slice(-this.maxMessages) : history;

    // Re-insert so the key moves to the end of the Map's iteration order,
    // which is what `evictOldest` uses as its recency list.
    this.conversations.delete(key);
    this.conversations.set(key, trimmed);
    this.#evictOldest();

    return trimmed.length;
  }

  /**
   * Forgets one conversation.
   * @returns {number} how many messages were discarded
   */
  clear(scope) {
    const key = ConversationMemory.key(scope);
    const existing = this.conversations.get(key);
    this.conversations.delete(key);
    return existing?.length ?? 0;
  }

  /** Forgets everything. Used by tests and by a deliberate global reset. */
  clearAll() {
    this.conversations.clear();
  }

  /** Number of conversations currently retained. */
  get size() {
    return this.conversations.size;
  }

  /** Total messages retained across all conversations. */
  get messageCount() {
    let total = 0;
    for (const history of this.conversations.values()) total += history.length;
    return total;
  }

  #evictOldest() {
    while (this.conversations.size > this.maxConversations) {
      const oldest = this.conversations.keys().next().value;
      this.conversations.delete(oldest);
    }
  }
}
