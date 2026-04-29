// Shared TLD list used by enrichment and the tlds-taken worker
const CHECK_TLDS = [
  // Core gTLDs
  '.com', '.net', '.org', '.info', '.biz', '.co', '.us',
  // Tech / startup
  '.io', '.ai', '.app', '.dev', '.tech', '.digital', '.cloud', '.software',
  '.systems', '.network', '.codes', '.tools', '.build', '.run', '.works',
  '.solutions', '.services', '.engineering', '.technology', '.computer',
  // Media / content
  '.tv', '.media', '.news', '.blog', '.social', '.live', '.online', '.site',
  '.web', '.click', '.link', '.stream', '.video', '.audio', '.studio',
  // Brand / personality
  '.me', '.gg', '.cc', '.vc', '.xyz', '.inc', '.llc', '.agency', '.group',
  '.team', '.club', '.pro', '.one', '.global', '.world', '.space', '.zone',
  '.life', '.guru', '.ninja', '.expert', '.consulting', '.ventures',
  // Commerce
  '.shop', '.store', '.market', '.trade', '.deals', '.sale', '.auction',
  '.finance', '.capital', '.fund', '.holdings', '.exchange', '.partners',
  '.company', '.business', '.enterprises', '.associates', '.international',
  // Creative
  '.design', '.art', '.photography', '.gallery', '.creative', '.productions',
  '.graphics', '.photos',
  // Other common gTLDs
  '.ly', '.sh', '.bot', '.plus', '.academy', '.center', '.foundation',
  '.institute', '.education', '.school', '.university', '.science',
  '.health', '.care', '.fit', '.gym', '.games', '.fun', '.entertainment',
  '.events', '.show', '.band', '.music', '.radio',
  '.legal', '.law', '.attorney', '.insurance', '.mortgage', '.loans',
  '.energy', '.solar', '.green', '.eco',
  '.pizza', '.coffee', '.beer', '.wine', '.restaurant', '.food', '.kitchen',
  '.travel', '.flights', '.hotel', '.estate', '.properties', '.land',
  '.city', '.town', '.place',
  // Major ccTLDs
  '.de', '.fr', '.es', '.it', '.nl', '.ca', '.ru', '.br', '.in',
  '.uk', '.au', '.jp', '.cn', '.ch', '.se', '.no', '.dk', '.fi',
  '.pl', '.cz', '.at', '.be', '.pt', '.gr', '.ro', '.hu', '.ie',
  '.mx', '.ar', '.cl', '.za', '.sg', '.hk', '.tw', '.kr', '.id',
  '.ph', '.th', '.vn', '.my', '.nz', '.ae', '.sa', '.tr', '.il',
  '.ng', '.ke', '.eg', '.ma', '.pk', '.lk', '.is', '.lt', '.lv', '.ee',
];

module.exports = { CHECK_TLDS };
