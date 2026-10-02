/**
 * Channel-aware context.
 *
 * Maps a Discord channel name onto the part of the MiningFools project that
 * channel is about, so an answer in #performans starts from optimisation rather
 * than from the project as a whole.
 *
 * This is a plain lookup table: the channel name is the only Discord state the
 * AI layer ever reads, and an unknown channel simply yields no hint.
 */

export const CHANNEL_FOCUS = Object.freeze({
  // ⛏️ MININGFOOLS
  pompai: 'General PompAI assistant channel. Answer MiningFools questions on any topic; ask for the channel that fits if the question is clearly about one area.',
  genel: 'General MiningFools discussion.',
  duyurular: 'Project announcements.',
  fikirler: 'Ideas, suggestions and feedback about the project.',

  // 🌍 OYUN DÜNYASI
  maden: 'Mining and digging: resource extraction, ore and veins, dig mechanics, tool tiers, and depth/mine progression.',
  ada: 'The island: world layout, environment, terrain, navigation and exploration.',
  marketler: 'The economy: the sales market, selling resources and pricing, and the upgrade market.',
  'iskele-ve-tekne': 'Dock and boat: mooring, sailing, buoyancy, water interaction and boat physics.',

  // 🎮 GAMEPLAY
  karakter: 'The player: character controller, movement, equipment, inventory and animation.',
  ekonomi: 'Economic systems: currency, prices, sources and sinks, and economy balance.',
  ilerleme: 'Progression: unlocks, tiers, pacing and long-term goals.',

  // 🛠️ GELİŞTİRME
  unity: 'Unity implementation: engine APIs, prefabs, scenes, components, serialization and editor tooling.',
  kod: 'Programming and architecture: C# structure, patterns, naming, refactoring and code review.',
  buglar: 'Debugging: reproducing, isolating and fixing defects.',
  'test-build': 'Test builds and playtest feedback.',
  performans: 'Performance: profiling, frame time, GC pressure, draw calls, batching and memory.',

  // 🎁 FIRSATLAR
  'bedava-oyunlar': 'Free game giveaways announced by PompAI. This is an alerts channel, not a MiningFools discussion channel; if the question is about the project, point the user at the right channel.',

  // 🎵 MÜZİK
  'muzik-istek': 'Music requests. A plain song name here starts playback; this is not a discussion or question channel.',

  // 🎉 EĞLENCE
  eglence:
    'The community games channel: mining (/kaz), the daily chest (/gunluk), party games (/parti) and the rest of the fun layer. Answers here are about how those games work, not about the game project itself.',

  // 🎨 TASARIM
  assetler: 'Assets: 3D models, textures, materials and import settings.',
  gorseller: 'Visuals: concept art, colour and lighting.',
  'ui-ux': 'Interface and user experience: layout, readability and interaction flow.',
  'ses-muzik': 'Game audio: sound effects, music, mixing and audio implementation.',
});

/** Normalises a channel name for lookup. */
export function normaliseChannelName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/**
 * @param {string|null|undefined} channelName
 * @returns {string|null} the focus hint, or null when the channel is unknown
 */
export function describeChannelFocus(channelName) {
  const key = normaliseChannelName(channelName);
  if (key === '') return null;
  return CHANNEL_FOCUS[key] ?? null;
}

/**
 * Renders the channel section of the system prompt.
 *
 * @param {string|null|undefined} channelName
 * @returns {string}
 */
export function describeChannelContext(channelName) {
  const key = normaliseChannelName(channelName);
  if (key === '') {
    return 'The Discord channel is unknown. Answer about MiningFools in general.';
  }

  const focus = describeChannelFocus(channelName);
  if (!focus) {
    return `Discord channel: #${key}. No specific focus is known for this channel; answer generally.`;
  }
  return `Discord channel: #${key}. Focus your answer on: ${focus}`;
}
