// Pre-written joke fortunes for the fortune command; no AI or network needed,
// and nothing here predicts real health, money or relationships.

import { pickFrom } from './pick.js';

export const FORTUNES = Object.freeze([
  'Bugün kazman sağlam toprağa denk gelecek. Yine de yedek kazmanı yanına al.',
  'Yakında bir böcekle karşılaşacaksın. O seni değil, sen onu bulacaksın.',
  'Şansın parlak: bugün ilk denemede derleyeceksin. Yine de kaydetmeyi unutma.',
  'Bilinmeyen bir tünel seni bekliyor. İçeri girmeden önce fenerini kontrol et.',
  'Bugün bir değişkenin adını yanlış yazacaksın. Bu, günün en küçük sınavı olacak.',
  'Yıldızlar senin için iyi haber veriyor: bugün sunucuda güzel bir sohbet seni bekliyor.',
  'Bir güncelleme yolda. İndirme tamamlanmadan sakın heyecanlanma.',
  'Bugün kaybettiğin bir dosyayı bulacaksın. Ama aradığın dosya başka yerde olacak.',
  'Şans senden yana: bugün en zor başarımı kıl payı kaçıracak ve tekrar deneyeceksin.',
  'Derinlerde parlak bir şey var. Onu görmek için önce karanlığa alışmalısın.',
  'Bir arkadaşın sana bir oyun önerecek. Ona "belki" diyeceksin, sonra 40 saat oynayacaksın.',
  'Bugün konsol temiz görünebilir. Yine de her satırı iki kez oku.',
  'Kaderin ilginç: bugün bir hatayı düzelteceksin, yerine iki yeni hata doğacak.',
  'Bir cevher gibi parlıyorsun. Ama kesme taşını yanlış açıyla vuracaksın.',
  'Bugün kaydetme tuşuna basmayı unutacaksın. Bu, sana hayatın dersini verecek.',
  'Şans kapını çalıyor. Muhtemelen çaldıktan sonra "yanlış kapı" deyip gidecek.',
  'Yakında bir yama gelecek. Beklediğin şeyi düzeltmeyecek ama yenisini bozacak.',
  'Bugün bir tünelde ilerlerken güzel bir manzaraya denk geleceksin. Muhtemelen bir lav gölü.',
  'Sesli kanalda biri sana gülecek. İyi anlamda olduğuna emin ol.',
  'Bugün bir hedefi tam zamanında tamamlayacaksın. Ödülün bir sonraki hedef olacak.',
  'Şansın yerinde: bugün yeni bir fikir bulacaksın ve onu yarına kadar unutacaksın.',
  'Bir sunucu etkinliği yakında. Katılırsan kazanacaksın, katılmazsan pişman olacaksın.',
  'Bugün en sevdiğin oyun seni şaşırtacak. İyi yönde olup olmadığını zaman gösterecek.',
  'Kazman hazır, fenerin yanıyor, cesaretin yerinde. Tek eksik: doğru yön.',
  'Bugün kimsenin görmediği bir hata bulacaksın. Onu kimseye söylemeyeceksin.',
  'Derinliklerin sırrı sabırda. Bugün sabrın sınanacak.',
]);

/** One random fortune. Clamps the injected random like every other bank. */
export function pickFortune(random = Math.random) {
  return pickFrom(FORTUNES, random);
}
