// Static question banks for the "parti" commands. Kept as curated data (no AI)
// so the server always gets safe, on-brand Turkish prompts instantly.

import { pickFrom } from './pick.js';

export const PARTY_TYPES = Object.freeze(['dogruluk', 'cesaret', 'kim-daha-olasi']);

/** Shown as the embed title; `command` matches the slash-command name. */
export const PARTY_META = Object.freeze({
  dogruluk: Object.freeze({ emoji: '🎭', title: 'DOĞRULUK', command: 'dogruluk' }),
  cesaret: Object.freeze({ emoji: '🔥', title: 'CESARET', command: 'cesaret' }),
  'kim-daha-olasi': Object.freeze({ emoji: '👀', title: 'KİM DAHA OLASI?', command: 'kim-daha-olasi' }),
});

// Every cesaret entry must be doable from a chair in a text/voice channel and
// must stay safe for a mixed-age server: no substances, risk, money or privacy.
export const PARTY_BANKS = Object.freeze({
  dogruluk: Object.freeze([
    'Sunucuda en son kimi stalkladın?',
    'En son ne zaman bir oyuna para verip pişman oldun?',
    'Bu sunucuda ilk tanıştığın kişi kimdi ve ilk izlenimin ne oldu?',
    'Şu ana kadar attığın en utanç verici mesaj hangisiydi?',
    'En son hangi oyunu bırakamadığın için uykusuz kaldın?',
    'Sunucuda en çok kime benzemek istediğini hiç düşündün mü?',
    'Bir oyunu oynarken en son ne zaman gerçekten sinirlendin?',
    'Profil fotoğrafını en son ne zaman değiştirdin ve neden o fotoğrafı seçtin?',
    'Hiç oyun içinde yalan söyleyip yakalandın mı?',
    'Sunucudaki en sevdiğin espriyi tekrar eder misin?',
    'En son ne zaman bir oyunu sırf arkadaşların oynuyor diye oynadın?',
    'Şu an odanda olsa utandığın bir eşya var mı?',
    'Hiç oyunda kaybettiğin için çok yaklaşıp üzüldün mü?',
    'En son ne zaman birine oyunda yardım ederken kendini kaybettin?',
    'Sunucuda en çok hangi tür mesajlara gülüyorsun?',
    'Hiç oyun oynarken uyuyakaldın mı? Uyandığında ne oldu?',
    'En sevdiğin oyun karakteri kim ve neden?',
    'Bir oyunu ilk kez oynadığında yaşadığın en komik anı anlat.',
    'Sunucuda en son kime "iyi oyunlar" dedin ve gerçekten öyle miydi?',
    'Bugüne kadar en çok hangi oyuna saat harcadın?',
    'Oyun oynarken en son ne zaman bir şeyi yanlış anladın?',
    'Hiç oyunda kazandığın bir şeyi kaybedip pişman oldun mu?',
    'En son ne zaman bir oyunu bıraktın ve neden bıraktın?',
    'Şu an oyun kütüphanende oynayıp da bitiremediğin kaç oyun var?',
    'Sunucuda en çok kiminle oyun oynamak istersin ve neden?',
    'En son ne zaman bir hata yüzünden oyunu yeniden başlatmak zorunda kaldın?',
  ]),
  cesaret: Object.freeze([
    'Ses kanalında 30 saniye boyunca robot gibi konuş.',
    'Profilindeki en eski mesajı bul ve yüksek sesle oku.',
    'Son 10 mesajını sırayla, hiç gülmeden oku.',
    'Ses kanalında en sevdiğin oyun karakterinin taklidini yap.',
    'Yazdığın en uzun mesajı bul ve hızlıca üç kez tekrar et.',
    'Sesli kanalda 20 saniye boyunca sadece "evet" diyerek cevap ver.',
    'Sunucudaki en sevdiğin emojiyi üç cümleyle savun.',
    'Kendi mesajlarından birini opera tonunda söyle.',
    'Sesli kanalda bir dakika boyunca fısıltıyla konuş.',
    'Profilindeki durum mesajını yüksek sesle oku ve neden yazdığını anlat.',
    'Ses kanalında en sevdiğin şarkının nakaratını mırıldan.',
    'Kendine yeni bir takma ad bul ve bir gün boyunca onu kullan.',
    'Sunucudaki bir arkadaşına iltifat eden üç cümle yaz.',
    'Sesli kanalda en son attığın üç mesajı drama tonunda oku.',
    'Kendi kullanıcı adını üç farklı şekilde telaffuz et.',
    'Bir dakika boyunca sadece ünlem cümleleriyle konuş.',
    'Sunucuya bugünkü en kötü esprini yaz ve herkesi güldürmeye çalış.',
    'Sesli kanalda ciddi bir spiker gibi hava durumunu sun.',
    'En son izlediğin videoyu tek cümleyle özetle ve abart.',
    'Klavyende en çok kullandığın tuşu bir dakika boyunca öv.',
    'Sunucudaki son beş mesajı bir haber bülteni gibi sun.',
    'Sesli kanalda bir replik seç ve onu üç farklı duyguyla söyle.',
    'Kendi yazdığın en utanç verici mesajı bul ve yüksek sesle oku.',
    'Bir dakika boyunca her cümlenin sonuna "kesinlikle" ekle.',
    'Sesli kanalda en sevdiğin oyunu bir reklam gibi tanıt.',
    'Sunucuda hiç kullanmadığın bir emojiyi bugün üç kez kullan.',
  ]),
  'kim-daha-olasi': Object.freeze([
    '"Sabah 6\'ya kadar oyun oynayıp ertesi gün pişman olmaya" en yatkın kişi kim?',
    '"Sunucuya gece 4\'te mesaj atıp herkesi uyandırmaya" en yatkın kişi kim?',
    '"Bir oyundaki hatayı bulmak için üç saat harcamaya" en yatkın kişi kim?',
    '"En sevdiği oyunu herkese saatlerce anlatmaya" en yatkın kişi kim?',
    '"Yeni bir proje başlatıp ikinci gün bırakmaya" en yatkın kişi kim?',
    '"Sesli kanalda bir anda şarkı söylemeye başlamaya" en yatkın kişi kim?',
    '"Oyun içinde kaybolup haritada üç saat dolaşmaya" en yatkın kişi kim?',
    '"Kimsenin sormadığı bir konuda uzun bir yazı yazmaya" en yatkın kişi kim?',
    '"Discord\'da emoji kullanmadan tek kelime yazmaya" en yatkın kişi kim?',
    '"Yeni bir güncelleme gelir gelmez saatlerce oynamaya" en yatkın kişi kim?',
    '"Bir oyunda en zor başarımları kasmaya" en yatkın kişi kim?',
    '"Kendi kodundaki hatayı bulmak için sabaha kadar uyanık kalmaya" en yatkın kişi kim?',
    '"Sunucuda en çok alıntılanan mesajı yazmaya" en yatkın kişi kim?',
    '"Bir oyunu bitirmeden yenisini almaya" en yatkın kişi kim?',
    '"Sesli kanalda mikrofonu açık unutup kendi kendine konuşmaya" en yatkın kişi kim?',
    '"Bir arkadaşına saatlerce oyun öğretmeye sabretmeye" en yatkın kişi kim?',
    '"Sunucunun en eski mesajlarını kazıp çıkarmaya" en yatkın kişi kim?',
    '"Bir oyunu sırf grafikleri güzel diye saatlerce oynamaya" en yatkın kişi kim?',
    '"Yeni bir sunucu açıp bir haftada unutmaya" en yatkın kişi kim?',
    '"En sevdiği oyunun savunmasını sonuna kadar yapmaya" en yatkın kişi kim?',
    '"Gecenin bir yarısı aniden felsefe yapmaya" en yatkın kişi kim?',
    '"Oyun içinde rastgele birine yardım etmeye" en yatkın kişi kim?',
    '"Bir hatayı kullanıp sunucuda övünmeye" en yatkın kişi kim?',
    '"Profilini ayda bir tamamen değiştirmeye" en yatkın kişi kim?',
    '"Uzun bir aradan sonra geri dönüp herkese yetişmeye" en yatkın kişi kim?',
    '"Kimse istemeden sunucuya yeni bir etkinlik önermeye" en yatkın kişi kim?',
  ]),
});

const NO_QUESTIONS = Object.freeze([]);

/** True only for the three supported party types. */
export function isPartyType(value) {
  return PARTY_TYPES.includes(value);
}

/** The frozen bank for a type, or an empty frozen array for anything unknown. */
export function questionsFor(type) {
  if (!isPartyType(type)) return NO_QUESTIONS;
  return PARTY_BANKS[type];
}

/** One random question, or null for an unknown type or empty bank. */
export function pickQuestion(type, random = Math.random) {
  return pickFrom(questionsFor(type), random);
}
