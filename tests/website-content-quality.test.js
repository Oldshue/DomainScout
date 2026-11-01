
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSpamText } = require('../server/website-content-quality');
const { websitePurpose } = require('../server/sale-watch-evidence');

test('explicit multilingual gambling promotions do not become business-adoption evidence', () => {
  for (const text of ['在线博彩与体育投注', '真人游戏、棋牌捕鱼，体彩全站、注册即送', 'Онлайн казино и игровые автоматы', 'كازينو المراهنات', 'คาสิโน พนันออนไลน์', 'Play casino jackpot today']) assert.equal(isSpamText(text), true, text);
  for (const text of ['汽车电瓶、汽车配件、光学设计', '体育训练、足球赛程和篮球新闻', '棋牌文化与历史研究', '真人电影与学生艺术展', 'Промышленное оборудование и оптика', 'Design tooling for a neighborhood bakery', 'Book available appointment slots at our clinic', 'Situs web untuk sekolah dan usaha kecil']) assert.equal(isSpamText(text), false, text);
});

test('fresh observation classification also reads descriptive metadata', () => {
  const purpose = websitePurpose({ title: 'Example platform', html: '<html><head><meta name="description" content="在线博彩与体育投注"></head><body><h1>Example platform</h1></body></html>', finalUrl: 'https://example.com/', status: 200 });
  assert.equal(purpose.spam, true);
  assert.equal(purpose.kind, 'spam');
});


test('exact default hosting and verification titles are excluded in fresh observations', () => {
  const { isRealTitle } = require('../server/live-sites');
  for (const title of ['Site is created successfully!', '请验证... / Please verify...', 'Please verify...', 'Verify you are human']) assert.equal(isRealTitle(title, 'example.com'), false, title);
  for (const title of ['Success Academy', 'Verify Identity Platform', 'Please Verify Your Business — Acme', 'Created Successfully — a design studio']) assert.equal(isRealTitle(title, 'example.com'), true, title);
});
