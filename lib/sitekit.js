// Site setup kit: a once-per-site (not per article) prompt for the site
// builder covering what every brand site needs beyond article pages: Meta
// Pixel wiring done correctly for a single page app, the IndexNow key file,
// visible freshness dates, and the paid-social link template. Built from
// the workspace profile so each brand gets its own pixel and key.

const host = (url) => {
  try { return new URL(url).host; } catch { return ''; }
};

export function buildSiteSetupKit(profile, indexNowKey) {
  const biz = profile?.business || {};
  const site = biz.links?.website || '';
  const siteHost = host(site) || '[your site domain]';
  const pixel = String(biz.metaPixelId || '').replace(/\D/g, '');
  const brand = biz.name || 'this brand';
  const out = [];

  out.push(`# Site setup kit for ${brand}`, '',
    'Paste this whole document into the site builder (Lovable) once. It is separate from the per-article Website Kit. Do the sections in order and tell me when each is live.', '');

  out.push('## 1. Freshness on every article page', '',
    '- Show a visible line near the top of each article: "Updated [month day, year]", using the dateModified value already inside that page\'s JSON-LD.',
    '- Keep the dateModified in the JSON-LD real. It changes only when the article text actually changes, never on a redeploy.',
    '- Keep the page server rendered (prerendered HTML), so the article text and JSON-LD exist in the raw HTML. AI crawlers do not run JavaScript.', '');

  out.push('## 2. IndexNow key file', '',
    'IndexNow tells Bing and other participating engines the moment a page is new or changed.',
    `- Create a public static file served at https://${siteHost}/${indexNowKey}.txt`,
    `- The file contents must be exactly this one line and nothing else: ${indexNowKey}`,
    '- In Lovable this means adding the file to the public folder so it is served from the site root.',
    '- Then re-save the article URL in ContentStudio; it checks the file is live before submitting.', '');

  if (pixel) {
    out.push('## 3. Meta Pixel', '',
      `Pixel ID: ${pixel}. Site: ${siteHost}.`, '',
      'Scope (important):',
      '- Install it ONCE, site wide, from the app entry. Do not add it to individual article pages (that double fires every event).',
      '- It only works on sites we own. It cannot run inside LinkedIn, YouTube, Google Business Profile, Facebook or Instagram posts, or Reels. Those channels send people to this site through the tracked links, and the pixel measures them here.',
      `- If this pixel ID is shared by more than one brand site, add custom data to EVERY event so audiences stay separable: { site: '${siteHost}', brand: '${brand}' }. In Meta, build audiences with a URL contains ${siteHost} rule plus that brand value, so a corporate-events visitor is never retargeted with consumer cruise ads, and the reverse.`,
      '',
      'Privacy and consent (required before it goes live):',
      '- Call fbq(\'consent\', \'revoke\') before init. Call fbq(\'consent\', \'grant\') only after the visitor accepts a cookie banner. If the site has no cookie banner, add one first with Accept and Decline buttons that carry equal weight, and remember the choice.',
      '- Treat a Global Privacy Control signal (navigator.globalPrivacyControl === true) as Decline.',
      '- Add a footer link, "Privacy choices", that reopens the banner so a visitor can change their mind at any time.',
      '- Update the Privacy Policy to say the site uses the Meta Pixel for measurement and advertising, what it collects (page views, button clicks, form submission events, device and browser data), that Meta receives it, and how to opt out.',
      '- Do not turn on Advanced Matching. Never pass a name, email address, phone number, trip dates, traveler details, or anything about health or accessibility needs in an event, a URL, or custom data.',
      '- Never load the pixel on /admin, /portal, client proposal pages, or any URL that contains a client name. Gate it with an allowlist of public marketing routes, not a blocklist.', '',
      'Base code (adapt to the app, keep the pixel ID):', '',
      '```js',
      '!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version=\'2.0\';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,\'script\',\'https://connect.facebook.net/en_US/fbevents.js\');',
      'fbq(\'consent\', \'revoke\');',
      `fbq('init', '${pixel}');`,
      '// after consent is granted: fbq(\'consent\', \'grant\');',
      '// then, on first render and on every route change: fbq(\'track\', \'PageView\');',
      '```', '',
      'This is a single page app: the standard snippet fires PageView only on the first document load, so do NOT call PageView in the base code. Fire it from one small component inside the router, on first render and on every route change, and only after consent is granted.', '',
      'Events (exact names; fire only where the site really has the thing):',
      '- PageView: every allowed route change, after consent.',
      '- ViewContent: main offer pages (retreat page, a sailing page, a service page). Include content_name (the page title) and content_category (for example "retreat", "sailing", "corporate-events").',
      '- Lead: fire ONLY when a form submission is confirmed successful, never on button click. Give each Lead a random UUID event_id and keep it, so a later server-side Conversions API event can be deduplicated against it.',
      '- Contact: fire when a visitor clicks a tel: or mailto: link.',
      '- Embedded third-party forms (for example a Google Form in an iframe): the pixel cannot see a submission inside the frame, so do not call that a Lead. Fire ViewContent when the form page loads, and fire Lead only if the form can redirect to a thank-you page on this site, in which case fire it on that page.', '',
      'After install, in Meta Events Manager:',
      '1. Open Test events, load the site, and confirm PageView appears on every route change and Lead appears on a test submission.',
      '2. Confirm NOTHING fires before the banner is accepted, none fire after Decline, and none fire on excluded routes. Use the Meta Pixel Helper extension.',
      '3. Verify the domain in Business Settings, Brand Safety, Domains (meta tag or DNS TXT record).',
      '4. Open Aggregated Event Measurement for the domain and rank the events, Lead first, then Contact, then ViewContent, then PageView.',
      '5. Server-side Conversions API is not set up yet. When it is, it needs an access token and reuses these event_id values.', '');
  } else {
    out.push('## 3. Meta Pixel', '',
      'No pixel ID is on file for this brand yet. Add it in the Story Interview (Business step, Meta Pixel ID) and rebuild this kit.', '');
  }

  out.push('## 4. Paid social link template', '',
    'Paid links stay separate from organic ones so reports are not mixed. Use this pattern as the destination URL in Meta ads:', '',
    `https://${siteHost}/[page]?utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}`, '',
    'Paste the {{...}} parts exactly as written into the ad\'s URL parameters; Meta fills them in per ad. Organic links from ContentStudio use utm_medium=organic and are unchanged.', '');
  return out.join('\n');
}
