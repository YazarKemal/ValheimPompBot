// Curated MiningFools-flavoured titles used by the nickname command. Written
// in advance so every user gets a playful, never-insulting result immediately.

import { pickFrom } from './pick.js';

export const NICKNAMES = Object.freeze([
  'Kazma Ustası',
  'Elmas Avcısı',
  'Maden Ocağı Kahramanı',
  'Nadir Cevher Uzmanı',
  'Mağara Kâşifi',
  'Tünel Mühendisi',
  'Kaya Kırıcı',
  'Derinliklerin Efendisi',
  'Cevher Avcısı',
  'Lav Geçidi Rehberi',
  'Işık Feneri Bekçisi',
  'Zümrüt Toplayıcısı',
  'Demir Damarı Dedektifi',
  'Yerin Altı Kaptanı',
  'Karanlık Tünel Şefi',
  'Kırılmayan Kazma',
  'Ocak Başı Ustası',
  'Tozlu Eldiven Kahramanı',
  'Altın Damarı Bekçisi',
  'Fenerli Kâşif',
  'Yeraltı Haritacısı',
  'Gizli Geçit Avcısı',
  'Sabırlı Kazmacı',
  'Cevher Tartıcısı',
  'Maden Ocakları Efsanesi',
  'Gece Nöbeti Ustası',
]);

/** One random nickname title. Clamps the injected random like every other bank. */
export function pickNickname(random = Math.random) {
  return pickFrom(NICKNAMES, random);
}
