'use strict';

/**
 * Language primitives for the live trends index: compact stop-word lists for
 * the common web languages (no dependency), a Unicode tokenizer and a cheap
 * dominant-language detector.
 *
 * Domaining is a global business: nothing here drops a site or a keyword for
 * being non-English. Stop words (articles, prepositions, pronouns, auxiliaries)
 * are removed in every language; real keywords are kept in every language and
 * script. Spam removal is never language-based (see operator templates in
 * server/live-trends.js).
 *
 * Latin-script tokens are diacritic-folded (für -> fur, café -> cafe) so the
 * same Latin token is one keyword across languages; other scripts keep NFC.
 */

const fold = s => s.normalize('NFKD').replace(/\p{M}/gu, '');

const RAW = {
  en: 'the and of to in is for with on are this that you your our we it at by from as be an or will can has have was not all more about its their they them us my me he she his her what which who how when where why there here also just than then so if into out up do does did been being were would could should may might must',
  es: 'de la que el en y los del se las por un una para con no su al lo como mas pero sus le ya este esta si porque entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos esto mi antes algunos unos yo otro otras otra tanto esa estos mucho quienes muchos cual poco ella estar estas algunas algo nosotros mis tu te ti tus ellas nuestro nuestra nuestros nuestras vuestro es son fue ser han hacer puede tiene usted ustedes',
  fr: 'le la les de des du un une et en au aux ce ces dans pour par sur avec ne pas plus que qui quoi dont ou est sont il elle ils elles nous vous je tu on se sa son ses leur leurs mon ma mes ton ta tes notre nos votre vos cette cet mais donc car ni comme tout tous toute toutes etre avoir fait faire ete lui sans sous chez entre vers aussi tres',
  de: 'der die das und in zu den von mit sich des auf fur ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem uber einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei ihr ihre ihrem ihren unser unsere wir ich du kann konnen alle hier dieser diese dieses jetzt euch ihnen',
  pt: 'de a o que e do da em um para com nao uma os no se na por mais as dos como mas ao ele das seu sua ou quando muito nos ja eu tambem pelo pela ate isso ela entre depois sem mesmo aos seus quem nas me esse eles voce essa num nem suas meu minha numa pelos elas qual nosso nossa sao ser tem foi esta este',
  it: 'di e il la che a per un in del della le non con una si da al dei delle gli lo ma come piu anche sono nel nella alla alle sul sulla questo questa tra fra ha ho se ed cui loro suo sua suoi mio mia tuo tua nostro nostra essere stato tutto tutti dove quando',
  nl: 'de en van het een in is dat op te zijn met voor niet aan er om ook als bij of door maar uit dan ze wat nog naar je ik we hij zij was worden wordt heeft hebben deze dit die onze ons jouw uw meer al tot over',
  id: 'yang dan di ke dari untuk dengan ini itu dalam pada adalah tidak akan juga atau oleh karena ada bisa kami kita anda saya mereka sudah telah lebih sebagai para bagi hanya seperti tersebut agar dapat serta namun jika maka masih harus belum sangat setiap semua antara secara tentang hingga sampai sebuah',
  ms: 'yang dan di ke dari untuk dengan ini itu dalam pada adalah tidak akan juga atau oleh kerana ada boleh kami kita anda saya mereka sudah telah lebih sebagai bagi hanya seperti tersebut supaya dapat serta namun jika maka masih perlu belum sangat setiap semua antara secara tentang hingga sehingga sebuah ialah',
  tr: 've bir bu da de ile icin olarak gibi daha en cok ama veya ne su ki mi mu var yok olan her ise kadar sonra once ben sen biz siz onlar bizim sizin hem ya diye ancak tum',
  pl: 'w na z do nie sie to jest ze o jak po co tak za od ale czy jego jej ich przez dla juz lub sa przy tylko tym ten ta te oraz bez nad pod tez jako nas was moze sobie',
  sv: 'och i att det som en pa ar av for med till den har inte om ett de jag men vi var sig ska kan fran eller nar ocksa sa an vid hos efter under mot alla mycket dig din ditt dina oss era',
  da: 'og i at det er en til af pa for med den de som har ikke et om vi jeg men kan var fra eller nar ogsa sa end ved hos efter under mod alle meget din dit dine os jeres',
  no: 'og i at det er en til av pa for med den de som har ikke et om vi jeg men kan var fra eller nar ogsa sa enn ved hos etter under mot alle mye din ditt dine oss deres',
  ro: 'si de la in cu pe din pentru ca care este sunt nu un mai sau dar al ale ai lui ei se ne va fi au acest aceasta acesta prin despre sa fara dupa tot toate',
  vi: 'va cua cac nhung cho voi trong duoc la mot nay khong co cung de tai nguoi khi den thi se da dang rat nhieu hon tu ve theo',
  tl: 'ang ng sa mga na at ay si ni ko mo ka siya kami kayo sila ito iyan iyon para may din rin lang po ba kung pero dahil',
  fi: 'ja on ei se etta joka kun mutta tai ole oli ovat kanssa myos niin kuin jos han he me te mina sina sen sita tama tassa nyt vain viela',
  cs: 'se na je ze do jako pro ale by jsou byl jak tak ktery ktera ktere jeho jeji jejich od po pri bez nebo uz jen take',
  hu: 'az es hogy nem is egy ez meg de van volt mint csak mar el ki be fel le vagy ha ezt azt majd igen nagyon sem itt ott minden',
  ru: 'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему когда даже ли если уже или ни быть был до вас вам там себя ей может они тут где есть надо ней для мы тебя их чем была сам без чего тоже себе под будет тогда кто этот того потому этого какой здесь этом мой тем чтобы сейчас были всех можно при об после над больше тот через эти нас про всего них много свою этой перед более всегда между наш наши ваш',
};

const LANG_STOP = new Map(Object.entries(RAW).map(([lang, list]) => [lang, new Set(list.split(/\s+/).filter(Boolean).map(w => (/^\p{Script=Latin}+$/u.test(w) ? fold(w) : w.normalize('NFC'))))]));
const STOP_LANGUAGES = Object.freeze([...LANG_STOP.keys()]);

// How many lists carry each stop word: shared words weigh less in detection.
const STOP_SPREAD = new Map();
for (const set of LANG_STOP.values()) for (const w of set) STOP_SPREAD.set(w, (STOP_SPREAD.get(w) || 0) + 1);

/** Every stop word of every language (articles, prepositions, pronouns, auxiliaries). */
// Function words in one language that are real keywords elsewhere (ai, car,
// mod, pro, ar, man): still used for language detection, never removed.
const KEEP_TOKENS = new Set(['ai', 'car', 'mod', 'pro', 'ar', 'man', 'app', 'bio', 'art']);
const STOP_ALL = new Set([...STOP_SPREAD.keys()].filter(w => !KEEP_TOKENS.has(w)));

// Navigation, legal and cart boilerplate in the common web languages.
const WEB_STOP_INTL = new Set(fold(`inicio contacto contato contactez kontakt kontak hubungi impressum datenschutz privacidad privacidade confidentialite mentions legales aviso cookies carrito carrinho panier warenkorb keranjang winkelwagen connexion anmelden iniciar sesion sessao entrar masuk daftar accueil startseite beranda pagina principal suchen buscar rechercher cari zoeken menu tutup cerrar fermer schliessen`).split(/\s+/).filter(Boolean));

// Scripts whose language follows from the script alone.
const SCRIPT_LANG = [
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'ja'],
  [/\p{Script=Hangul}/u, 'ko'],
  [/\p{Script=Han}/u, 'zh'],
  [/\p{Script=Thai}/u, 'th'],
  [/\p{Script=Arabic}/u, 'ar'],
  [/\p{Script=Hebrew}/u, 'he'],
  [/\p{Script=Greek}/u, 'el'],
  [/\p{Script=Devanagari}/u, 'hi'],
  [/\p{Script=Cyrillic}/u, 'ru'],
];
const LANGUAGES = Object.freeze([...new Set([...STOP_LANGUAGES, ...SCRIPT_LANG.map(([, l]) => l)])].sort());
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const LATIN_TOKEN = /^[\p{Script=Latin}\p{M}\p{N}]+$/u;

// A run of one script family: Latin (+digits), CJK/kana, or any other letters.
const RUN_RE = /[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{M}\p{N}]*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+|[\p{L}\p{M}\p{N}]+/gu;
// Japanese particles that glue unspaced runs together.
const JA_PARTICLES = /[のはがをにでとへもや]/u;

/**
 * Lowercased word tokens in any script; Latin tokens diacritic-folded. Mixed
 * runs split at script boundaries (最新のAIエージェント -> 最新, ai, エージェント);
 * Japanese runs also split at single-kana particles; unspaced runs longer
 * than 8 characters (no cheap word boundary) are skipped.
 */
function tokenize(text) {
  const out = [];
  for (const word of String(text || '').normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}ー]+/gu) || []) {
    for (const raw of word.match(RUN_RE) || []) {
      if (LATIN_TOKEN.test(raw)) { out.push(fold(raw)); continue; }
      if (NO_SPACE_SCRIPT.test(raw)) {
        for (const piece of raw.split(JA_PARTICLES)) if (piece.length >= 2 && piece.length <= 8) out.push(piece);
        continue;
      }
      out.push(raw);
    }
  }
  return out;
}

const isStopWord = token => STOP_ALL.has(token);

/**
 * Dominant language of a page from its tokens, cheaply: a non-Latin script that
 * makes up most letters decides (Cyrillic is scored against the Russian list),
 * otherwise stop-word hits per language weighted by 1/spread. Returns a
 * language code or null when the evidence is thin or ambiguous.
 */
function detectLanguage(input) {
  const tokens = Array.isArray(input) ? input : tokenize(input);
  if (!tokens.length) return null;
  let latin = 0; let other = 0;
  const scriptHits = new Map();
  for (const t of tokens) {
    if (LATIN_TOKEN.test(t)) { latin += t.length; continue; }
    other += t.length;
    for (const [re, lang] of SCRIPT_LANG) if (re.test(t)) { scriptHits.set(lang, (scriptHits.get(lang) || 0) + t.length); break; }
  }
  if (other > latin && scriptHits.size) {
    // Kana marks Japanese even when Han dominates.
    if (scriptHits.has('ja')) return 'ja';
    return [...scriptHits].sort((a, b) => b[1] - a[1])[0][0];
  }
  const score = new Map();
  for (const t of tokens.slice(0, 400)) {
    const spread = STOP_SPREAD.get(t);
    if (!spread) continue;
    for (const [lang, set] of LANG_STOP) if (set.has(t)) score.set(lang, (score.get(lang) || 0) + 1 / spread);
  }
  const ranked = [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length || ranked[0][1] < 0.4) return null;
  if (!ranked[1] || ranked[0][1] > ranked[1][1] + 1e-9) return ranked[0][0];
  // Exact tie: sibling languages sharing most function words resolve to the
  // larger web language; any other tie is ambiguous.
  const tied = ranked.filter(r => Math.abs(r[1] - ranked[0][1]) < 1e-9).map(r => r[0]).sort().join('|');
  return SIBLINGS[tied] || null;
}

const SIBLINGS = { 'id|ms': 'id', 'da|no': 'da', 'da|no|sv': 'sv', 'no|sv': 'sv' };

module.exports = { KEEP_TOKENS, LANG_STOP, STOP_LANGUAGES, STOP_ALL, WEB_STOP_INTL, LANGUAGES, tokenize, isStopWord, detectLanguage, fold };
