'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lt = require('../server/live-trends');
const langs = require('../server/live-trends-lang');

function rec(day, domain, title, extra = {}) {
  return {
    domain, day, class: 'built', reason: 'operating_site', title,
    description: extra.description === undefined ? null : extra.description,
    text: extra.text || null, titleReal: true, spam: false, kit: null,
    fingerprint: { title: extra.fpTitle || title, skeleton: extra.skeleton || `sk-${domain}` },
    observedAt: `${day}T09:00:00.000Z`,
  };
}

async function writeDay(dir, day, records, file = 'observations.jsonl') {
  const sites = path.join(dir, day, 'sites');
  await fs.mkdir(sites, { recursive: true });
  await fs.appendFile(path.join(sites, file), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-trends-q-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { universeDir: path.join(dir, 'universe'), cacheDir: path.join(dir, 'cache') };
}

const find = (list, keyword) => (list || []).find(item => item.keyword === keyword);
const FILLER = ['de', 'en', 'la', 'para', 'dan', 'di', 'yang', 'und', 'fur', 'et', 'pour', 'des', 'der', 'die', 'le', 'les', 'el', 'untuk'];

const MULTI = {
  es: ['Hotel boutique de la playa para familias en Cancun', 'Reserva tu hotel en la ciudad de Madrid con el mejor precio', 'Hotel rural para parejas en la sierra de Granada', 'Tienda de ropa para toda la familia en Sevilla', 'Clinica dental para la familia en Valencia'],
  fr: ['Hotel de charme pour des vacances en Provence', 'Le meilleur hotel pour la famille et des enfants', 'Boulangerie artisanale pour le pain et des croissants', 'Cabinet dentaire pour la famille et les enfants'],
  de: ['Hotel und Restaurant fur die ganze Familie in Bayern', 'Das beste Hotel fur Ihren Urlaub und die Familie', 'Software fur die Buchhaltung und das Lager', 'Zahnarzt fur die Familie und die Kinder'],
  id: ['Hotel murah untuk keluarga di Bali dan sekitarnya', 'Toko baju yang murah untuk wanita di Jakarta', 'Jasa desain rumah yang modern untuk keluarga di Bandung', 'Kursus bahasa Inggris yang mudah untuk anak di Surabaya'],
};

test('multilingual filler: stop words of every common web language are removed, real keywords stay in every language', async t => {
  assert.ok(langs.STOP_LANGUAGES.length >= 15);
  const dirs = await tmp(t);
  const day = '2026-10-20';
  let n = 0;
  for (const [lang, titles] of Object.entries(MULTI)) {
    await writeDay(dirs.universeDir, day, titles.map(title => rec(day, `site${lang}x${String.fromCharCode(97 + n++)}q.com`.replace(/\d/g, ''), title)));
  }
  const trends = lt.createLiveTrends(dirs);
  const body = await trends.query({ window: '7d', source: 'text', kind: 'biggest', limit: '100' });
  const words = body.biggest.map(x => x.keyword);
  for (const f of FILLER) assert.ok(!words.includes(f), `filler ${f} must not be counted`);
  // real keywords in every language are counted
  for (const kw of ['hotel', 'familia', 'famille', 'familie', 'keluarga', 'murah']) assert.ok(words.includes(kw), kw);
  const hotel = find(body.biggest, 'hotel');
  const hotelLangs = Object.fromEntries(hotel.languages.map(l => [l.lang, l.operators]));
  assert.ok(hotelLangs.es >= 2 && hotelLangs.fr >= 2 && hotelLangs.de >= 2, JSON.stringify(hotel.languages));
  assert.equal(hotel.global, true, 'same Latin token rising in several languages is global');
  assert.equal(find(body.biggest, 'keluarga').global, false);
  // lang filter: only Indonesian sites
  const id = await trends.query({ window: '7d', source: 'text', kind: 'biggest', lang: 'id', limit: '100' });
  assert.equal(id.lang, 'id');
  assert.ok(find(id.biggest, 'keluarga'));
  assert.equal(find(id.biggest, 'familie'), undefined);
  await assert.rejects(trends.query({ lang: 'xx' }), /lang must be/);
  // detection
  assert.equal(lt.siteLanguage({ title: MULTI.es[0] }), 'es');
  assert.equal(lt.siteLanguage({ title: MULTI.id[1] }), 'id');
  assert.equal(lt.siteLanguage({ title: MULTI.de[0] }), 'de');
  assert.equal(lt.siteLanguage({ title: MULTI.fr[0] }), 'fr');
  // frontier-ish tokens are never stop words
  for (const kw of ['ai', 'app', 'mod', 'car']) assert.equal(langs.isStopWord(kw), false, kw);
  // global boost raises a global term's score
  assert.equal(lt.globalSignal('hotel', [{ lang: 'es', operators: 3, recent: 1 }, { lang: 'fr', operators: 2, recent: 1 }]).global, true);
  assert.ok(lt.globalSignal('hotel', [{ lang: 'es', operators: 3, recent: 1 }, { lang: 'fr', operators: 2, recent: 1 }]).boost > 1);
  assert.equal(lt.globalSignal('hotel', [{ lang: 'es', operators: 3, recent: 1 }]).global, false);
});

const APPS = ['whatsapp', 'tiktok', 'capcut', 'spotify', 'netflix', 'telegram', 'instagram', 'snapchat', 'youtube', 'shopee', 'grab', 'gojek', 'dana', 'ovo', 'canva', 'lightroom', 'picsart', 'zoom', 'discord', 'twitter'];
const VARIANTS = [
  (app, v) => `${app} v${v} APK Resmi untuk Android - Unduh Gratis`,
  (app, v) => `Unduh ${app} ${v} APK resmi untuk Android | Ulasan dan Cek SHA`,
  (app, v) => `${app} Mod v${v} APK Resmi untuk Android Ponsel`,
];

test('template network: 300 sites with slightly varying titles collapse to one operator and the network size is reported', async t => {
  const dirs = await tmp(t);
  const days = ['2026-10-18', '2026-10-19', '2026-10-20'];
  for (let d = 0; d < days.length; d++) {
    const rows = [];
    for (let i = 0; i < 100; i++) {
      const n = d * 100 + i;
      const app = APPS[n % APPS.length];
      rows.push(rec(days[d], `${app}apk${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26) % 26)}.xyz`, VARIANTS[n % 3](app, `${4 + (n % 5)}.${n % 10}.${n % 7}`)));
    }
    await writeDay(dirs.universeDir, days[d], rows);
  }
  // Ten independent Android developers, different titles.
  const indie = ['Pocket budget planner for Android', 'Android tutoring for kids', 'Offline maps for Android hikers', 'Android repair shop in Leeds', 'Kotlin and Android consulting', 'Android game studio Lisbon', 'Weather widgets for Android', 'Android kiosk management', 'Field survey app for Android', 'Android launcher themes gallery'];
  await writeDay(dirs.universeDir, '2026-10-20', indie.map((title, i) => rec('2026-10-20', `indie${String.fromCharCode(97 + i)}dev.com`, title)));
  const trends = lt.createLiveTrends(dirs);
  const body = await trends.query({ window: '7d', source: 'text', kind: 'biggest', limit: '100' });
  const resmi = find(body.biggest, 'resmi');
  assert.ok(resmi, 'network keyword still listed');
  assert.equal(resmi.operators, 1, 'the network is one operator');
  assert.equal(find(body.biggest, 'unduh').operators, 1);
  assert.equal(find(body.biggest, 'android').operators, 11, '10 independent + the network');
  const nets = body.coverage.networks;
  assert.ok(nets.collapsed >= 1);
  const big = nets.top[0];
  assert.equal(big.sites, 300);
  assert.equal(big.spamKit, true);
  assert.ok(big.template);
  // independent sites are not merged into any network
  assert.ok(body.coverage.operators >= 11 && body.coverage.operators <= 12, String(body.coverage.operators));
  // template keys: brand and numbers removed
  const a = lt.templateKeys({ d: 'capcutapkab.xyz', ds: ['capcut', 'apk'], ti: 'capcut v4.1.2 APK Resmi untuk Android - Unduh Gratis' });
  const b = lt.templateKeys({ d: 'zoomapkcd.xyz', ds: ['zoom', 'apk'], ti: 'zoom v5.3.0 APK Resmi untuk Android - Unduh Gratis' });
  assert.ok(a.some(k => b.includes(k)));
  // a few same-template sites below the threshold stay independent
  const few = [0, 1, 2].map(i => ({ d: `x${i}.com`, day: '2026-10-20', ds: [], ti: 'Fresh bread delivered daily in town', ok: [`l:x${i}`] }));
  const idx = lt.operatorIndex(few);
  assert.notEqual(idx(few[0]), idx(few[1]));
});

const SYL = ['ba', 'ko', 'mi', 'ru', 'te', 'lo', 'ne', 'su', 'vi', 'da', 'po', 'ze'];
const nonce = n => SYL[n % 12] + SYL[Math.floor(n / 12) % 12] + SYL[Math.floor(n / 144) % 12] + 'q';
const GENERIC = ['bakery', 'florist', 'garage', 'tailor', 'dentist', 'plumber', 'gallery', 'kennel', 'salon', 'pharmacy'];

test('coverage gap: uncovered days are excluded, rise is on share so CT volume does not inflate it', async t => {
  const dirs = await tmp(t);
  const plan = [];
  // 10-14..10-21: 20 operators/day (2 coffee, 1 robotics); 10-22..24: no data; 10-25..27: 100/day (10 coffee, 20 robotics).
  for (let d = 14; d <= 27; d++) {
    if (d >= 22 && d <= 24) continue;
    const late = d >= 25;
    plan.push({ day: `2026-10-${d}`, total: late ? 100 : 20, coffee: late ? 10 : 2, robotics: late ? 20 : 1, file: late ? 'ct-launches.jsonl' : 'observations.jsonl' });
  }
  let n = 0;
  for (const p of plan) {
    const rows = [];
    for (let i = 0; i < p.total; i++) {
      const w = nonce(n);
      // Title word differs from the label so each site keeps a distinct title key (independent operators).
      const tw = nonce(500 + n++);
      const title = i < p.coffee ? `${tw} coffee bar` : i < p.coffee + p.robotics ? `${tw} robotics lab` : `${tw} ${GENERIC[i % GENERIC.length]}`;
      rows.push(rec(p.day, `${w}.com`, title));
    }
    await writeDay(dirs.universeDir, p.day, rows, p.file);
  }
  const trends = lt.createLiveTrends(dirs);
  const body = await trends.query({ window: '14d', source: 'text', kind: 'all', limit: '100' });
  const cov = body.coverage.rise;
  assert.deepEqual(cov.excludedDays, ['2026-10-22', '2026-10-23', '2026-10-24']);
  assert.deepEqual(cov.recentDays, ['2026-10-25', '2026-10-26', '2026-10-27']);
  assert.deepEqual(cov.priorDays, ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
  assert.equal(cov.sufficient, true);
  assert.equal(cov.recentOperators, 300);
  assert.equal(body.coverage.days.find(d => d.day === '2026-10-23').covered, false);
  const coffee = find(body.biggest, 'coffee');
  assert.ok(coffee.rise != null && coffee.rise < 1.5, `flat share is not a rise: ${coffee.rise}`);
  assert.equal(coffee.share.recent, 0.1);
  assert.equal(find(body.trending, 'coffee'), undefined);
  const robotics = find(body.biggest, 'robotics');
  assert.ok(robotics.rise > 2, String(robotics.rise));
  assert.ok(find(body.trending, 'robotics'));
  // insufficient coverage: no rise at all
  const thin = lt.riseWindows([new Set([1, 2, 3, 4]), null, null, new Set([5, 6, 7])]);
  assert.equal(thin.sufficient, false);
  assert.equal(lt.shareRise(10, 1, thin), null);
  // share-based stage: a falling share cannot be forming
  assert.equal(lt.stageFor({ opsLastWeek: 5, daysLastWeek: 3, roles: 2, riseRaw: 0.5 }), 'watch');
  assert.equal(lt.stageFor({ opsLastWeek: 5, daysLastWeek: 3, roles: 2, riseRaw: 1.4 }), 'forming');
});

test('novelty: established words (chatgpt, saas, a steadily registered word) do not emerge; new vocabulary (mcp) does', async t => {
  const dirs = await tmp(t);
  // 43 days of universe registration history, all before the 14-day site span (starts 2026-10-07).
  const SUFFIX = ['shop', 'store', 'online', 'group', 'world'];
  for (let k = 0; k < 43; k++) {
    const d = new Date(Date.parse('2026-08-25T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
    const dir = path.join(dirs.universeDir, d, 'tape');
    await fs.mkdir(dir, { recursive: true });
    const lines = [`zyntek${SUFFIX[k % 5]}\tcom\t${d}`, `zyntek${SUFFIX[(k + 1) % 5]}\tnet\t${d}`, `chatgpt${SUFFIX[k % 5]}\tcom\t${d}`, `bluebeans\tcom\t${d}`];
    await fs.writeFile(path.join(dir, 'adds.tsv'), lines.join('\n') + '\n');
  }
  const days = ['2026-10-18', '2026-10-19', '2026-10-20'];
  const rows = { '2026-10-18': [], '2026-10-19': [], '2026-10-20': [] };
  const add = (i, domain, title, text) => rows[days[i % 3]].push(rec(days[i % 3], domain, title, { text }));
  const N = ['alpha', 'harbor', 'cedar', 'maple'];
  N.forEach((w, i) => add(i, `${w}relay.ai`, `${w} MCP server for AI agents`, 'connect tools with mcp'));
  N.forEach((w, i) => add(i, `${w}writer.com`, `${w} ChatGPT writing assistant`, 'chatgpt prompts'));
  N.forEach((w, i) => add(i, `${w}ledger.io`, `${w} SaaS billing platform`, 'saas subscriptions'));
  N.forEach((w, i) => add(i, `${w}parts.net`, `${w} Zyntek replacement parts`, 'zyntek dealers'));
  // Generic background so coverage exists each day.
  for (let i = 0; i < 9; i++) add(i, `${nonce(900 + i)}.com`, `${nonce(950 + i)} ${GENERIC[i]}`);
  for (const d of days) await writeDay(dirs.universeDir, d, rows[d]);
  const trends = lt.createLiveTrends({ ...dirs, buildBudget: 100 });
  const body = await trends.query({ window: '7d', source: 'text', kind: 'emerging', limit: '100' });
  const items = body.emerging.map(e => e.keyword);
  assert.ok(items.includes('mcp'), JSON.stringify(items));
  for (const old of ['chatgpt', 'saas', 'zyntek']) assert.ok(!items.includes(old), `${old} is established, not emerging`);
  assert.ok(items.indexOf('mcp') < 3, 'new vocabulary ranks high');
  const mcp = body.emerging.find(e => e.keyword === 'mcp');
  assert.ok(mcp.evidence.baselineFrequency.days >= 43, JSON.stringify(mcp.evidence.baselineFrequency));
  assert.equal(mcp.evidence.baselineFrequency.established, false);
  assert.ok(body.coverage.baselineDays >= 43);
  // vocabulary and history tests
  assert.equal(lt.isEstablishedVocabulary('chatgpt'), true);
  assert.equal(lt.isEstablishedVocabulary('saas'), true);
  assert.equal(lt.isEstablishedVocabulary('mcp'), false);
  assert.equal(lt.isEstablishedVocabulary('autonomous agents'), false);
  assert.equal(lt.historyEstablished({ days: 43, presentDays: 43, count: 86, growth: 1 }), true);
  assert.equal(lt.historyEstablished({ days: 43, presentDays: 3, count: 3, growth: 8 }), false);
  assert.ok(lt.emergingScore({ term: 'autonomous agents', operators: 4, roles: 2, frontierShare: 0.5 }) > 0);
  assert.equal(lt.emergingScore({ term: 'chatgpt', operators: 40 }), 0);
});
