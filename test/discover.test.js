import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLd, parsePageData, parseRss, parseSitemap, parseOpenGraph, parseCards, parseFrontPage, fetchFrontPage, feedCandidates, sitemapCandidates, kindFromUrl, titleFromUrl, discoverFeed, READER_UA } from '../server/ingest/discover.js';
import { adapterFor } from '../server/ingest/adapters.js';

const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Films</title>
<item><title><![CDATA[Harbour Lights &amp; Fog]]></title><link>https://site.test/watch/1</link><pubDate>Tue, 02 May 2023 10:00:00 GMT</pubDate><media:thumbnail url="https://cdn.test/1.jpg"/></item>
<item><title>Copper Sky</title><link>/series/copper-sky</link><description><![CDATA[<p>Two seasons.</p><img src="/p/2.jpg">]]></description></item>
<item><title>No link</title></item>
</channel></rss>`;
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom One</title><link href="https://site.test/v/1"/><published>2020-01-01T00:00:00Z</published></entry></feed>`;
const sitemapIndex = `<sitemapindex><sitemap><loc>https://site.test/sitemap-pages.xml</loc></sitemap><sitemap><loc>https://site.test/sitemap-movies-1.xml.gz</loc></sitemap></sitemapindex>`;
const videoSitemap = `<urlset xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
<url><loc>https://site.test/movies/red-static</loc><video:video><video:thumbnail_loc>https://cdn.test/rs.jpg</video:thumbnail_loc><video:title>Red Static</video:title><video:publication_date>2018-03-01</video:publication_date></video:video></url>
<url><loc>https://site.test/series/blue-hour</loc><video:video><video:title>Blue Hour &amp; After</video:title></video:video></url>
<url><loc>https://site.test/about</loc></url>
</urlset>`;
const jsonld = `<html><head><link rel="alternate" type="application/rss+xml" href="/films.rss"><script type="application/ld+json">
{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
 {"@type":"ListItem","position":1,"item":{"@type":"Movie","name":"Red Static","url":"/movies/red-static","image":"https://cdn.test/rs.jpg","datePublished":"2018-03-01"}},
 {"@type":"ListItem","position":2,"url":"https://site.test/series/blue-hour","name":"Blue Hour"},
 {"@type":"ListItem","position":3,"item":{"@type":"TVEpisode","name":"Blue Hour S01E02","url":"/episode/blue-hour-2","thumbnailUrl":"/t.jpg"}}]}
</script><script type="application/ld+json">{"@type":"VideoObject","name":"Loose Clip","contentUrl":"https://site.test/clip/1","thumbnailUrl":"/c.jpg"}</script></head></html>`;

test('page kinds come from the url path', () => {
  assert.equal(kindFromUrl('https://x.test/series/foo'), 'series');
  assert.equal(kindFromUrl('https://x.test/tv-shows/foo/s01e02'), 'episode');
  assert.equal(kindFromUrl('https://x.test/movies/foo'), 'movie');
  assert.equal(kindFromUrl('https://x.test/watch/123'), undefined);
});

test('rss and atom entries become records with artwork from thumbnails or the description', () => {
  const items = parseRss(rss, 'https://site.test/feed');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: 'Harbour Lights & Fog', url: 'https://site.test/watch/1', image: 'https://cdn.test/1.jpg', kind: undefined, year: '2023' });
  assert.deepEqual(items[1], { title: 'Copper Sky', url: 'https://site.test/series/copper-sky', image: 'https://site.test/p/2.jpg', kind: 'series', year: undefined });
  const a = parseRss(atom, 'https://site.test/atom.xml');
  assert.deepEqual(a, [{ title: 'Atom One', url: 'https://site.test/v/1', image: undefined, kind: undefined, year: '2020' }]);
});

test('sitemaps split into child sitemaps and video entries; pages without video are skipped', () => {
  const idx = parseSitemap(sitemapIndex, 'https://site.test/sitemap.xml');
  assert.deepEqual(idx.children, ['https://site.test/sitemap-pages.xml', 'https://site.test/sitemap-movies-1.xml.gz']);
  assert.equal(idx.items.length, 0);
  const v = parseSitemap(videoSitemap, 'https://site.test/sitemap-movies-1.xml');
  assert.equal(v.items.length, 2);
  assert.deepEqual(v.items[0], { title: 'Red Static', url: 'https://site.test/movies/red-static', image: 'https://cdn.test/rs.jpg', kind: 'movie', year: '2018' });
  assert.equal(v.items[1].title, 'Blue Hour & After');
  assert.equal(v.items[1].kind, 'series');
});

test('json-ld lists and loose video objects on a page become records', () => {
  const items = parseJsonLd(jsonld, 'https://site.test/');
  assert.deepEqual(items.map((i) => [i.title, i.url, i.kind]), [
    ['Red Static', 'https://site.test/movies/red-static', 'movie'],
    ['Blue Hour', 'https://site.test/series/blue-hour', 'series'],
    ['Blue Hour S01E02', 'https://site.test/episode/blue-hour-2', 'episode'],
    ['Loose Clip', 'https://site.test/clip/1', 'movie'],
  ]);
  assert.equal(items[0].image, 'https://cdn.test/rs.jpg');
  assert.equal(items[0].year, '2018');
  assert.equal(items[2].image, 'https://site.test/t.jpg');
});

test('feed and sitemap candidates: declared links first, then the usual paths', () => {
  const f = feedCandidates(jsonld, 'https://site.test/home');
  assert.equal(f[0], 'https://site.test/films.rss');
  assert.ok(f.includes('https://site.test/feed'));
  const s = sitemapCandidates('User-agent: *\nDisallow: /x\nSitemap: https://site.test/sm/index.xml\n', 'https://site.test');
  assert.equal(s[0], 'https://site.test/sm/index.xml');
  assert.ok(s.includes('https://site.test/sitemap.xml'));
});

/** A fake site served from a map of url -> body; everything else is a 404. */
function fakeFetch(pages) {
  return async (url) => { if (!(url in pages)) throw new Error(`HTTP 404 from ${url}`); return { text: pages[url], type: 'text/xml', url }; };
}
const five = (make) => Array.from({ length: 5 }, (_, i) => make(i)).join('');
const rssFive = `<rss><channel>${five((i) => `<item><title>Film ${i}</title><link>https://site.test/w/${i}</link></item>`)}</channel></rss>`;
const videoFive = `<urlset>${five((i) => `<url><loc>https://site.test/movies/${i}</loc><video:video><video:title>Movie ${i}</video:title><video:thumbnail_loc>https://cdn.test/${i}.jpg</video:thumbnail_loc></video:video></url>`)}</urlset>`;

test('the finder prefers structured data, then a declared feed, then video sitemaps from robots.txt', async () => {
  const quiet = { timeoutMs: 5000 };
  let r = await discoverFeed('https://site.test', '/', { ...quiet, fetchText: fakeFetch({ 'https://site.test/': jsonld.replace('"position":3', '"position":3').replace('</head>', `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[${Array.from({ length: 5 }, (_, i) => `{"name":"X${i}","url":"/x/${i}"}`).join(',')}]}</script></head>`) }) });
  assert.equal(r.feed.type, 'jsonld');
  assert.equal(r.how, 'structured data on the page');
  assert.ok(r.items.length >= 5);

  r = await discoverFeed('https://site.test', '/', { ...quiet, fetchText: fakeFetch({ 'https://site.test/': jsonld, 'https://site.test/films.rss': rssFive }) });
  assert.deepEqual(r.feed, { type: 'rss', url: 'https://site.test/films.rss' });

  r = await discoverFeed('https://site.test', '/', { ...quiet, fetchText: fakeFetch({ 'https://site.test/': '<html></html>', 'https://site.test/robots.txt': 'Sitemap: https://site.test/sm.xml', 'https://site.test/sm.xml': sitemapIndex.replace('sitemap-movies-1.xml.gz', 'sm-movies.xml'), 'https://site.test/sm-movies.xml': videoFive, 'https://site.test/sitemap-pages.xml': '<urlset><url><loc>https://site.test/a</loc></url></urlset>' }) });
  assert.deepEqual(r.feed, { type: 'sitemap', url: 'https://site.test/sm.xml', files: ['https://site.test/sm-movies.xml'] });
  assert.equal(r.items.length, 5);
  assert.equal(r.intervalSec, 86400);

  // Plain page lists are the last resort: titles from the addresses, under content paths only.
  const pageList = `<urlset>${Array.from({ length: 6 }, (_, i) => `<url><loc>https://site.test/video/film-number-${i}-ab12cd/</loc></url>`).join('')}<url><loc>https://site.test/about/</loc></url></urlset>`;
  r = await discoverFeed('https://site.test', '/', { ...quiet, fetchText: fakeFetch({ 'https://site.test/': '<html></html>', 'https://site.test/robots.txt': '', 'https://site.test/sitemap.xml': pageList }) });
  assert.deepEqual(r.feed, { type: 'pages', url: 'https://site.test/sitemap.xml', files: ['https://site.test/sitemap.xml'] });
  assert.equal(r.how, 'the list of its pages');
  assert.deepEqual(r.items.map((i) => i.title).slice(0, 2), ['film number 0', 'film number 1']);

  r = await discoverFeed('https://site.test', '/', { ...quiet, fetchText: fakeFetch({ 'https://site.test/': '<html>nothing here</html>' }) });
  assert.equal(r, null);
});

test('embedded page data: lists of records with a title, a link and pictures become titles', () => {
  const tiles = Array.from({ length: 6 }, (_, i) => ({ contentType: i % 2 ? 'movie' : 'series', href: `/movies/${i}/`, name: `Picture ${i}`, thumb: `https://img.test/${i}.jpg` }));
  const nav = Array.from({ length: 6 }, (_, i) => ({ title: `Menu ${i}`, href: `/menu/${i}` }));
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { nav, rows: [{ items: tiles }] } } })}</script>
    <script>window.__STATE__ = ${JSON.stringify({ more: tiles.map((t) => ({ ...t, href: t.href + 'x' })) })};</script></html>`;
  const items = parsePageData(html, 'https://site.test/us/on-demand');
  assert.equal(items.length, 12, 'both blobs, no nav menu');
  assert.deepEqual(items[0], { title: 'Picture 0', url: 'https://site.test/movies/0/', image: 'https://img.test/0.jpg', kind: 'series', year: undefined });
  assert.equal(items[1].kind, 'movie');
});

test('page addresses give rough titles and Open Graph tags give the real ones', () => {
  assert.equal(titleFromUrl('https://www.pbs.org/video/winterthur-hour-1-whnx1k/'), 'winterthur hour 1');
  assert.equal(titleFromUrl('https://site.test/movies/100049640/the-legend-of-bobby-churro'), 'the legend of bobby churro');
  assert.equal(titleFromUrl('https://site.test/video/'), '');
  assert.equal(titleFromUrl('https://archive.org/details/0fjqudm1cwkrvk6bol7f2odi3xemdo5avgx5f7kd'), '', 'an identifier is not a title');
  const og = parseOpenGraph('<html><head><meta property="og:title" content="Antiques Roadshow | Winterthur, Hour 1 | Season 24"/><meta property="og:image" content="/img/a.jpg?x=1"/><meta property="og:type" content="video.tv_show"/></head></html>', 'https://www.pbs.org/video/x/');
  assert.equal(og.image, 'https://www.pbs.org/img/a.jpg?x=1');
  assert.equal(og.kind, 'series');
  assert.match(og.title, /^Antiques Roadshow/);
  const plain = parseSitemap('<urlset><url><loc>https://site.test/video/blue-hour-s01e02-zz9k2q/</loc><image:image><image:loc>/p.jpg</image:loc></image:image></url><url><loc>https://site.test/help/</loc></url></urlset>', 'https://site.test/sm.xml');
  assert.deepEqual(plain.pages, [{ title: 'blue hour s01e02', url: 'https://site.test/video/blue-hour-s01e02-zz9k2q/', image: 'https://site.test/p.jpg', kind: undefined }]);
});

test('a discovered sitemap feed is pulled through the adapter, the judged sitemap first', async () => {
  const source = { id: 's', feed: { type: 'sitemap', url: 'https://site.test/sm.xml', files: ['https://site.test/sm-movies.xml'] } };
  const adapter = adapterFor(source);
  assert.ok(adapter);
  const rssSource = { id: 'r', feed: { type: 'rss', url: 'https://site.test/feed' } };
  assert.ok(adapterFor(rssSource));
  assert.ok(adapterFor({ id: 'p', feed: { type: 'pages', url: 'https://site.test/sm.xml', files: [] } }));
  assert.ok(adapterFor({ id: 'd', feed: { type: 'pagedata', url: 'https://site.test/' } }));
  assert.equal(adapterFor({ id: 'x' }), null);
});

// ---------- front page cards ----------

const cardsPage = `<html><head><title>Site</title><script>window.x = {"a":1}</script></head><body>
<nav><a href="/">Home</a><a href="/movies">Movies</a><a href="https://other.test/partner"><img src="/p.jpg" alt="Partner"></a></nav>
<section class="hero"><a aria-label="Blade II (2002)" href="/movie/blade-ii-2002?context=hero"></a><div><img alt="" src="/hero.jpg"></div></section>
<section class="row"><h2>Trending</h2>
${Array.from({ length: 6 }, (_, i) => `<a href="/movies/${100 + i}/title-${i}"><img alt="Title ${i} &amp; More" src="data:image/gif;base64,R0lGOD" data-src="/t/${i}.jpg"></a>`).join('')}
<a href="/movies/100/title-0"><img alt="Title 0 again" src="/t/0.jpg"></a>
<a href="/about/"><img src="/about.jpg" alt="About us"></a>
<a href="/series/9/show"><picture><source srcset="/s9.webp 1x, /s9@2x.webp 2x"><img alt="Show Nine" src="/s9.jpg"></picture></a>
</section></body></html>`;

test('front page cards: links with pictures, in page order, named by the page, lazy pictures and hero layouts included', () => {
  const cards = parseCards(cardsPage, 'https://www.site.test/');
  assert.deepEqual(cards.map((c) => c.title), ['Blade II (2002)', 'Title 0 & More', 'Title 1 & More', 'Title 2 & More', 'Title 3 & More', 'Title 4 & More', 'Title 5 & More', 'Show Nine']);
  assert.equal(cards[0].url, 'https://www.site.test/movie/blade-ii-2002?context=hero');
  assert.equal(cards[0].image, 'https://www.site.test/hero.jpg', 'a hero card has its picture just after the link');
  assert.equal(cards[0].kind, 'movie');
  assert.equal(cards[1].image, 'https://www.site.test/t/0.jpg', 'the lazy picture, not the placeholder');
  assert.equal(cards[7].image, 'https://www.site.test/s9.webp');
  assert.equal(cards[7].kind, 'series');
  assert.ok(!cards.some((c) => /about|partner|home/i.test(c.title)), 'menus, promo tiles and other sites are not cards');
});

test('front page cards: a page that puts each picture before its link keeps the right poster on each card', () => {
  const html = `<ul>${Array.from({ length: 6 }, (_, i) => `<li><img src="/pic/${i}.jpg"><a href="/videos/${i}">Video ${i}</a></li>`).join('')}</ul>`;
  const cards = parseCards(html, 'https://site.test/home');
  assert.equal(cards.length, 6);
  assert.deepEqual(cards.map((c) => c.image), Array.from({ length: 6 }, (_, i) => `https://site.test/pic/${i}.jpg`));
});

test('front page cards: a page with no content paths keeps every pictured link; fewer than twelve is a menu, not rows', () => {
  const html = `<div>${Array.from({ length: 4 }, (_, i) => `<a href="/thing/${i}"><img src="/${i}.jpg" alt="Thing ${i}"></a>`).join('')}</div>`;
  assert.equal(parseCards(html, 'https://site.test/').length, 4);
  assert.deepEqual(parseFrontPage(html, 'https://site.test/'), []);
  assert.equal(parseFrontPage(cardsPage, 'https://www.site.test/').length, 0);
  const big = cardsPage.replace('</section></body>', Array.from({ length: 8 }, (_, i) => `<a href="/movies/${200 + i}/more-${i}"><img alt="More ${i}" src="/m/${i}.jpg"></a>`).join('') + '</section></body>');
  const items = parseFrontPage(big, 'https://www.site.test/');
  assert.equal(items.length, 16);
  assert.equal(items[0].title, 'Blade II (2002)');
});

test('a page embedding its state with undefined values still gives up its tiles', () => {
  const tiles = Array.from({ length: 6 }, (_, i) => `{"name":"Tile ${i}","href":"/movies/${i}","thumb":"/t${i}.jpg","extra":undefined}`).join(',');
  const html = `<html><script>window.__data={"ui":{"x":undefined},"rows":[${tiles}]};</script></html>`;
  assert.equal(parsePageData(html, 'https://site.test/').length, 6);
});

const shell = '<html><body><div id="app"></div></body></html>';
const rendered = `<html><body>${Array.from({ length: 14 }, (_, i) => `<a href="/movies/${i}/film-${i}"><img alt="Film ${i}" src="/f${i}.jpg"></a>`).join('')}</body></html>`;

test('an empty app shell is asked for again as the hub itself, and the finder remembers which way worked', async () => {
  const asked = [];
  const ft = async (url, { ua } = {}) => { asked.push(ua || 'browser'); return { text: ua === READER_UA ? rendered : shell, type: 'text/html', url }; };
  const r = await fetchFrontPage('https://site.test/', { fetchText: ft });
  assert.equal(r.items.length, 14);
  assert.equal(r.reader, true);
  assert.deepEqual(asked, ['browser', READER_UA]);
  const again = await fetchFrontPage('https://site.test/', { fetchText: ft, reader: true });
  assert.equal(again.items.length, 14);
  assert.equal(asked.length, 3, 'a feed marked reader skips the browser try');
  const found = await discoverFeed('https://site.test', '/', { timeoutMs: 5000, fetchText: ft });
  assert.deepEqual(found.feed, { type: 'frontpage', url: 'https://site.test/', reader: true });
  assert.equal(found.how, 'the rows on its front page');
  assert.equal(found.items[0].title, 'Film 0');
});

test('the finder takes the front page over everything else when it has enough cards', async () => {
  const withLd = rendered.replace('<body>', `<body><script type="application/ld+json">{"@type":"ItemList","itemListElement":[${Array.from({ length: 6 }, (_, i) => `{"name":"X${i}","url":"/x/${i}"}`).join(',')}]}</script>`);
  const r = await discoverFeed('https://site.test', '/', { timeoutMs: 5000, fetchText: fakeFetch({ 'https://site.test/': withLd }) });
  assert.deepEqual(r.feed, { type: 'frontpage', url: 'https://site.test/' });
  assert.equal(r.intervalSec, 3600);
  assert.ok(adapterFor({ id: 'f', feed: r.feed }).featured);
});
