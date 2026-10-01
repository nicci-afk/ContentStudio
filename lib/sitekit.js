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
      `Pixel ID: ${pixel} (this brand only; do not reuse another brand's pixel).`, '',
      'Requirements:',
      '- Load the base code once, asynchronously, from the app entry or the HTML head. It must not block rendering or touch the prerendered content.',
      '- This is a single page app: the standard snippet fires PageView only on the first document load. Do NOT call PageView in the base code. Instead fire fbq(\'track\', \'PageView\') on the first render AND on every route change, from one small component inside the router.',
      '- Consent first: call fbq(\'consent\', \'revoke\') before init, and fbq(\'consent\', \'grant\') only after the visitor accepts the cookie banner. If the site has no consent banner yet, add one before enabling this.',
      '- Never fire the pixel on /admin or /portal routes.', '',
      'Base code (adapt to the app, keep the pixel ID):', '',
      '```js',
      '!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version=\'2.0\';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,\'script\',\'https://connect.facebook.net/en_US/fbevents.js\');',
      'fbq(\'consent\', \'revoke\');',
      `fbq('init', '${pixel}');`,
      '// after consent is granted: fbq(\'consent\', \'grant\');',
      '// then, on first render and on every route change: fbq(\'track\', \'PageView\');',
      '```', '',
      'Standard events (use these exact names, only on the forms and pages the site actually has):',
      '- Lead: fire once when an application or consultation inquiry form submits successfully (not on button click).',
      '- ViewContent: fire on the main offer pages (for example the retreat page or a service page).',
      '- Give each Lead an event_id (a random UUID) and keep it, so a later server-side Conversions API event can be deduplicated against it.', '',
      'After install: open Events Manager, Test events, load the site, and confirm PageView appears on every page change and Lead appears on a test submission. Then verify the domain in Business Settings (meta tag or DNS TXT record).', '');
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
