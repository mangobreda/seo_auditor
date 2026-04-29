import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

const DEFAULT_UA = 'ManGoSEOAuditor/React-1.0 (+https://www.mangoproductdesign.com/)';

function normalizeUrl(raw) {
  const u = new URL(raw.trim());
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

function safeNormalize(raw, base) {
  try {
    const absolute = new URL(raw, base);
    if (!['http:', 'https:'].includes(absolute.protocol)) return null;
    return normalizeUrl(absolute.toString());
  } catch {
    return null;
  }
}

function sameDomain(url, rootHost) {
  const host = new URL(url).hostname.toLowerCase();
  const root = rootHost.replace(/^www\./, '');
  return host === rootHost || host === root || host.endsWith('.' + root);
}

function titleIssues(title) {
  if (!title) return ['Missing title'];
  const n = title.trim().length;
  if (n < 30) return ['Title likely too short'];
  if (n > 60) return ['Title likely too long'];
  return [];
}

function metaIssues(desc) {
  if (!desc) return ['Missing meta description'];
  const n = desc.trim().length;
  if (n < 70) return ['Meta description likely too short'];
  if (n > 160) return ['Meta description likely too long'];
  return [];
}

async function request(url, timeoutSec, method = 'GET') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    const responseMs = Math.round(performance.now() - start);
    return { res, responseMs, error: null };
  } catch (err) {
    return { res: null, responseMs: null, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkExternalLink(url, timeoutSec) {
  let { res, responseMs, error } = await request(url, timeoutSec, 'HEAD');
  if (res && [403, 405].includes(res.status)) ({ res, responseMs, error } = await request(url, timeoutSec, 'GET'));
  if (error || !res) return { targetUrl: url, statusCode: null, finalUrl: null, responseMs, error };
  return { targetUrl: url, statusCode: res.status, finalUrl: normalizeUrl(res.url), responseMs, error: null };
}

async function auditPage(url, rootHost, timeoutSec, depth) {
  const { res, responseMs, error } = await request(url, timeoutSec, 'GET');
  const issues = [];
  const discovered = new Set();

  if (error || !res) {
    return { page: { url, depth, statusCode: null, finalUrl: null, contentType: null, responseMs, title: null, titleLen: 0, metaDescription: null, metaDescriptionLen: 0, h1Count: null, h1Text: null, canonical: null, canonicalIssue: null, robotsMeta: null, noindex: null, lang: null, viewport: null, wordCount: null, internalLinks: null, externalLinks: null, images: null, imagesMissingAlt: null, structuredDataBlocks: null, issues: `Fetch error: ${error}` }, discovered };
  }

  const statusCode = res.status;
  const contentType = res.headers.get('content-type') || '';
  const finalUrl = normalizeUrl(res.url);
  if (statusCode >= 400) issues.push(`HTTP ${statusCode}`);
  else if (statusCode >= 300) issues.push(`Redirect/status ${statusCode}`);
  if (finalUrl !== normalizeUrl(url)) issues.push('Redirects to different URL');
  if (responseMs && responseMs > 2000) issues.push('Slow response >2s');
  if (!finalUrl.startsWith('https://')) issues.push('Not HTTPS');

  if (!contentType.toLowerCase().includes('text/html')) {
    return { page: { url, depth, statusCode, finalUrl, contentType, responseMs, title: null, titleLen: 0, metaDescription: null, metaDescriptionLen: 0, h1Count: null, h1Text: null, canonical: null, canonicalIssue: null, robotsMeta: null, noindex: null, lang: null, viewport: null, wordCount: null, internalLinks: null, externalLinks: null, images: null, imagesMissingAlt: null, structuredDataBlocks: null, issues: [...new Set(issues)].join('; ') }, discovered };
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim() || null;
  const metaDescription = $('meta[name="description" i]').first().attr('content')?.trim() || null;
  const h1s = $('h1').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
  const canonicalRaw = $('link[rel~="canonical" i]').first().attr('href');
  const canonical = canonicalRaw ? safeNormalize(canonicalRaw, finalUrl) : null;
  const robotsMeta = $('meta[name="robots" i]').first().attr('content')?.trim() || null;
  const lang = $('html').first().attr('lang') || null;
  const viewport = $('meta[name="viewport" i]').length > 0;
  const text = $.root().text().replace(/\s+/g, ' ').trim();
  const wordCount = (text.match(/\b[\p{L}\p{N}_]+\b/gu) || []).length;
  const images = $('img');
  const imagesMissingAlt = images.filter((_, img) => !$(img).attr('alt')).length;
  const structuredDataBlocks = $('script[type*="ld+json" i]').length;

  issues.push(...titleIssues(title), ...metaIssues(metaDescription));
  if (h1s.length === 0) issues.push('Missing H1');
  else if (h1s.length > 1) issues.push('Multiple H1s');
  let canonicalIssue = null;
  if (!canonical) { canonicalIssue = 'Missing canonical'; issues.push(canonicalIssue); }
  else if (canonical !== finalUrl) { canonicalIssue = 'Canonical differs from final URL'; issues.push(canonicalIssue); }
  if (robotsMeta?.toLowerCase().includes('noindex')) issues.push('Noindex present');
  if (!lang) issues.push('Missing html lang');
  if (!viewport) issues.push('Missing viewport');
  if (wordCount < 250) issues.push('Thin content <250 words');
  if (imagesMissingAlt) issues.push(`${imagesMissingAlt} images missing alt`);
  if (structuredDataBlocks === 0) issues.push('No JSON-LD structured data');

  let internalLinks = 0;
  let externalLinks = 0;
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
    const absolute = safeNormalize(href, finalUrl);
    if (!absolute) return;
    discovered.add(absolute);
    if (sameDomain(absolute, rootHost)) internalLinks += 1;
    else externalLinks += 1;
  });

  return { page: { url, depth, statusCode, finalUrl, contentType, responseMs, title, titleLen: title?.length || 0, metaDescription, metaDescriptionLen: metaDescription?.length || 0, h1Count: h1s.length, h1Text: h1s.slice(0, 3).join(' | '), canonical, canonicalIssue, robotsMeta, noindex: Boolean(robotsMeta?.toLowerCase().includes('noindex')), lang, viewport, wordCount, internalLinks, externalLinks, images: images.length, imagesMissingAlt, structuredDataBlocks, issues: [...new Set(issues)].join('; ') }, discovered };
}


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { startUrl = 'https://www.mangoproductdesign.com/', maxPages = 150, maxDepth = 4, timeout = 10, includeExternal = true, concurrency = 4 } = req.body || {};
  try {
    const start = normalizeUrl(startUrl);
    const rootHost = new URL(start).hostname.toLowerCase();
    const queue = [{ url: start, depth: 0 }];
    const seen = new Set();
    const pages = [];
    const links = [];
    const externalToCheck = new Set();

    while (queue.length && pages.length < Number(maxPages)) {
      const { url, depth } = queue.shift();
      if (seen.has(url) || depth > Number(maxDepth)) continue;
      seen.add(url);
      const { page, discovered } = await auditPage(url, rootHost, Number(timeout), depth);
      pages.push(page);
      for (const link of [...discovered].sort()) {
        const internal = sameDomain(link, rootHost);
        links.push({ sourceUrl: url, targetUrl: link, type: internal ? 'internal' : 'external' });
        if (internal && !seen.has(link) && depth + 1 <= Number(maxDepth) && pages.length + queue.length < Number(maxPages)) queue.push({ url: link, depth: depth + 1 });
        if (!internal && includeExternal) externalToCheck.add(link);
      }
    }

    if (includeExternal && externalToCheck.size) {
      const limit = pLimit(Math.max(1, Math.min(Number(concurrency) || 4, 10)));
      const checks = await Promise.all([...externalToCheck].map(link => limit(() => checkExternalLink(link, Number(timeout)))));
      const byUrl = new Map(checks.map(c => [c.targetUrl, c]));
      for (const row of links) {
        if (row.type === 'external' && byUrl.has(row.targetUrl)) Object.assign(row, byUrl.get(row.targetUrl));
      }
    }

    res.json({ pages, links, summary: { checkedPages: pages.length, pagesWithIssues: pages.filter(p => p.issues).length, uniqueLinks: new Set(links.map(l => l.targetUrl)).size, averageResponseMs: Math.round(pages.filter(p => p.responseMs).reduce((a, p) => a + p.responseMs, 0) / Math.max(1, pages.filter(p => p.responseMs).length)) } });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }

}
