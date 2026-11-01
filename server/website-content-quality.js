'use strict';

// Text-only counterpart of websitePurpose's content-quality check. Both fresh
// observations and retained public-feed rows must use the same rule: a legacy
// `spam: false` flag does not establish that its current title/description is
// usable business-adoption evidence. Keep this pure so replay needs no fetching,
// DOM parsing, corpus join or keyword-seeded research job on the HTTP thread.
const LATIN_SPAM = /\b(?:casino|gacor|togel|judi|poker|sportsbook|betting|jackpot|lottery|rtp\s*live|porn|xxx|sex videos|escort|viagra|cialis|levitra|without prescription|online pharmacy(?! in)|semalt|indexjump|news insider|crypto exchange|обмен крипт|域名|出售)\b/i;
// Ordinary appointment slots and Indonesian situs (website) are not gambling.
const GAMBLING_CONTEXT = /\b(?:slots?\s+(?:gacor|casino|machines?|jackpot)|(?:play|online|casino)\s+(?:online\s+)?slots?|(?:bandar|situs)\s+(?:togel|judi|gacor|slots?))\b/iu;
const EXPLICIT_NON_LATIN_GAMBLING = /(?:赌场|賭場|博彩|六合彩|老虎机|老虎機|体育投注|體育投注|体育博彩|體育博彩|真人娱乐场|真人娛樂場|казино|игровые автоматы|ставки на спорт|كازينو|القمار|المراهنات|พนันออนไลน์|คาสิโน)/iu;
const GAME_PROMOTION = /(?:棋牌|捕鱼|捕魚|真人游戏|真人遊戲|真人娱乐|真人娛樂)/u;
const MONEY_PROMOTION = /(?:投注|体彩|體彩|彩票|注册即送|註冊即送|注册送|註冊送|返点|返點|充值|儲值|提现|提現|真钱|真錢)/u;

function isSpamText(value) {
  const text = String(value || '');
  return LATIN_SPAM.test(text) || GAMBLING_CONTEXT.test(text) || EXPLICIT_NON_LATIN_GAMBLING.test(text)
    || (GAME_PROMOTION.test(text) && MONEY_PROMOTION.test(text));
}

module.exports = { isSpamText };
