import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

const DEFAULT_UA = 'ManGoSEOAuditor/2.0 (+https://www.mangoproductdesign.com/)';
const SKIP_EXTENSIONS = /\.(zip|rar|7z|gz|tar|jpg|jpeg|png|gif|webp|svg|ico|pdf|doc|docx|xls|xlsx|ppt|pptx|mp4|mov|avi|mp3|wav|woff|woff2|ttf|eot)(\?.*)?$/i;

function normalizeUrl(raw) {
  const u = new URL(raw.trim());
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

function safeNormalize(raw, base) {
  try {
    const value = String(raw || '').trim();
    if (!value || /^(mailto:|tel:|javascript:|data:|sms:|whatsapp:)/i.test(value)) return null;
    const absolute = new URL(value, base);
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

function issue(code, severity, message, category = 'Technical SEO') {
  return { code, severity, message, category };
}

function addIssue(list, code, severity, message, category) {
  if (!list.some(i => i.code === code && i.message === message)) list.push(issue(code, severity, message, category));
}

function scoreFromIssues(issues) {
  const penalty = issues.reduce((sum, i) => sum + (i.severity === 'critical' ? 18 : i.severity === 'high' ? 10 : i.severity === 'medium' ? 5 : 2), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function statusSeverity(status) {
  if (!status) return 'critical';
  if (status >= 500) return 'critical';
  if (status >= 400) return 'high';
  if (status >= 300) return 'medium';
  return 'ok';
}

async function request(url, timeoutSec, method = 'GET', redirect = 'manual') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method,
      redirect,
      signal: controller.signal,
      headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    return { res, responseMs: Math.round(performance.now() - start), error: null };
  } catch (err) {
    return { res: null, responseMs: Math.round(performance.now() - start), error: err.name === 'AbortError' ? 'Request timed out' : (err.message || String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRedirects(url, timeoutSec, method = 'GET', maxRedirects = 6) {
  const chain = [];
  let current = url;
  let totalMs = 0;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const { res, responseMs, error } = await request(current, timeoutSec, method, 'manual');
    totalMs += responseMs || 0;
    if (error || !res) return { res, responseMs: totalMs, error, finalUrl: current, redirectChain: chain };
    const location = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      const next = safeNormalize(location, current);
      chain.push({ from: current, to: next || location, statusCode: res.status });
      if (!next) return { res, responseMs: totalMs, error: 'Invalid redirect location', finalUrl: current, redirectChain: chain };
      current = next;
      method = 'GET';
      continue;
    }
    return { res, responseMs: totalMs, error: null, finalUrl: normalizeUrl(res.url || current), redirectChain: chain };
  }
  return { res: null, responseMs: totalMs, error: 'Too many redirects', finalUrl: current, redirectChain: chain };
}

function extractJsonLd($) {
  const blocks = [];
  let invalid = 0;
  $('script[type*="ld+json" i]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        const graph = Array.isArray(item?.['@graph']) ? item['@graph'] : [item];
        for (const node of graph) {
          const type = node?.['@type'];
          if (type) blocks.push(Array.isArray(type) ? type.join(',') : String(type));
        }
      }
    } catch {
      invalid += 1;
    }
  });
  return { structuredDataTypes: [...new Set(blocks)].join(', '), invalidJsonLd: invalid, count: $('script[type*="ld+json" i]').length };
}

async function checkLink(url, timeoutSec, type) {
  if (SKIP_EXTENSIONS.test(new URL(url).pathname)) return { targetUrl: url, statusCode: null, finalUrl: url, responseMs: null, redirectCount: 0, linkIssue: '', linkSeverity: 'ok', error: '', skipped: true };
  let result = await fetchWithRedirects(url, timeoutSec, 'HEAD');
  if (result.res && [403, 405].includes(result.res.status)) result = await fetchWithRedirects(url, timeoutSec, 'GET');
  const statusCode = result.res?.status || null;
  const redirectCount = result.redirectChain.length;
  let linkIssue = '';
  let linkSeverity = 'ok';
  if (result.error || !result.res) { linkIssue = `Fetch error: ${result.error}`; linkSeverity = 'critical'; }
  else if (statusCode >= 400) { linkIssue = `Broken link HTTP ${statusCode}`; linkSeverity = statusCode >= 500 ? 'critical' : 'high'; }
  else if (redirectCount > 1) { linkIssue = `Redirect chain (${redirectCount})`; linkSeverity = 'medium'; }
  else if (redirectCount === 1) { linkIssue = 'Redirect'; linkSeverity = type === 'internal' ? 'medium' : 'low'; }
  return { targetUrl: url, statusCode, finalUrl: result.finalUrl ? normalizeUrl(result.finalUrl) : null, responseMs: result.responseMs, redirectCount, linkIssue, linkSeverity, error: result.error || '', skipped: false };
}

async function auditPage(url, rootHost, timeoutSec, depth) {
  const { res, responseMs, error, finalUrl, redirectChain } = await fetchWithRedirects(url, timeoutSec, 'GET');
  const issues = [];
  const discovered = new Set();
  const base = { url, depth, finalUrl, responseMs, redirectCount: redirectChain.length, redirectChain: redirectChain.map(r => `${r.statusCode}: ${r.from} -> ${r.to}`).join(' | ') };

  if (error || !res) {
    addIssue(issues, 'fetch_error', 'critical', `Fetch error: ${error}`, 'Crawlability');
    return { page: { ...base, statusCode: null, contentType: null, score: 0, issues, issueSummary: issues.map(i => i.message).join('; ') }, discovered };
  }

  const statusCode = res.status;
  const contentType = res.headers.get('content-type') || '';
  if (statusCode >= 400) addIssue(issues, 'http_error', statusSeverity(statusCode), `HTTP ${statusCode}`, 'Crawlability');
  if (redirectChain.length === 1) addIssue(issues, 'redirect', 'medium', 'Page redirects', 'Crawlability');
  if (redirectChain.length > 1) addIssue(issues, 'redirect_chain', 'high', `Redirect chain (${redirectChain.length})`, 'Crawlability');
  if (!finalUrl.startsWith('https://')) addIssue(issues, 'not_https', 'high', 'Not HTTPS', 'Security');
  if (responseMs > 2000) addIssue(issues, 'slow', 'medium', 'Slow response >2s', 'Performance');
  if (responseMs > 4000) addIssue(issues, 'very_slow', 'high', 'Very slow response >4s', 'Performance');

  if (!contentType.toLowerCase().includes('text/html')) {
    return { page: { ...base, statusCode, contentType, score: scoreFromIssues(issues), issues, issueSummary: issues.map(i => i.message).join('; ') }, discovered };
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim() || null;
  const metaDescription = $('meta[name="description" i]').first().attr('content')?.replace(/\s+/g, ' ').trim() || null;
  const h1s = $('h1').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
  const canonicalRaw = $('link[rel~="canonical" i]').first().attr('href');
  const canonical = canonicalRaw ? safeNormalize(canonicalRaw, finalUrl) : null;
  const robotsMeta = $('meta[name="robots" i]').first().attr('content')?.trim() || '';
  const lang = $('html').first().attr('lang') || '';
  const viewport = $('meta[name="viewport" i]').length > 0;
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = (text.match(/\b[\p{L}\p{N}_]+\b/gu) || []).length;
  const images = $('img');
  const imagesMissingAlt = images.filter((_, img) => !$(img).attr('alt')).length;
  const imagesEmptyAlt = images.filter((_, img) => $(img).attr('alt') === '').length;
  const linksWithoutText = $('a[href]').filter((_, a) => !$(a).text().replace(/\s+/g, ' ').trim() && !$(a).find('img[alt]').length).length;
  const nofollowLinks = $('a[rel~="nofollow" i]').length;
  const hreflangCount = $('link[rel="alternate" i][hreflang]').length;
  const ogTitle = $('meta[property="og:title" i]').attr('content') || '';
  const ogDescription = $('meta[property="og:description" i]').attr('content') || '';
  const mixedContent = $('[src], [href]').map((_, el) => $(el).attr('src') || $(el).attr('href')).get().filter(v => /^http:\/\//i.test(v)).length;
  const { structuredDataTypes, invalidJsonLd, count: structuredDataBlocks } = extractJsonLd($);

  if (!title) addIssue(issues, 'missing_title', 'high', 'Missing title', 'Metadata');
  else if (title.length < 30) addIssue(issues, 'short_title', 'medium', 'Title likely too short', 'Metadata');
  else if (title.length > 60) addIssue(issues, 'long_title', 'medium', 'Title likely too long', 'Metadata');
  if (!metaDescription) addIssue(issues, 'missing_meta_description', 'medium', 'Missing meta description', 'Metadata');
  else if (metaDescription.length < 70) addIssue(issues, 'short_meta_description', 'low', 'Meta description likely too short', 'Metadata');
  else if (metaDescription.length > 160) addIssue(issues, 'long_meta_description', 'low', 'Meta description likely too long', 'Metadata');
  if (h1s.length === 0) addIssue(issues, 'missing_h1', 'high', 'Missing H1', 'Content');
  if (h1s.length > 1) addIssue(issues, 'multiple_h1', 'medium', 'Multiple H1s', 'Content');
  if (!canonical) addIssue(issues, 'missing_canonical', 'medium', 'Missing canonical', 'Indexability');
  else if (canonical !== finalUrl) addIssue(issues, 'canonical_mismatch', 'medium', 'Canonical differs from final URL', 'Indexability');
  if (/noindex/i.test(robotsMeta)) addIssue(issues, 'noindex', 'high', 'Noindex present', 'Indexability');
  if (/nofollow/i.test(robotsMeta)) addIssue(issues, 'meta_nofollow', 'medium', 'Meta robots nofollow present', 'Indexability');
  if (!lang) addIssue(issues, 'missing_lang', 'low', 'Missing html lang', 'Accessibility');
  if (!viewport) addIssue(issues, 'missing_viewport', 'high', 'Missing viewport', 'Mobile');
  if (wordCount < 250) addIssue(issues, 'thin_content', 'medium', 'Thin content <250 words', 'Content');
  if (imagesMissingAlt) addIssue(issues, 'missing_alt', 'medium', `${imagesMissingAlt} images missing alt`, 'Accessibility');
  if (linksWithoutText) addIssue(issues, 'empty_links', 'medium', `${linksWithoutText} links without accessible text`, 'Accessibility');
  if (structuredDataBlocks === 0) addIssue(issues, 'no_schema', 'low', 'No JSON-LD structured data', 'Structured data');
  if (invalidJsonLd) addIssue(issues, 'invalid_schema', 'high', `${invalidJsonLd} invalid JSON-LD block(s)`, 'Structured data');
  if (mixedContent) addIssue(issues, 'mixed_content', 'high', `${mixedContent} HTTP asset/link references`, 'Security');
  if (!ogTitle || !ogDescription) addIssue(issues, 'missing_social_meta', 'low', 'Missing Open Graph title/description', 'Social');

  let internalLinks = 0;
  let externalLinks = 0;
  $('a[href]').each((_, a) => {
    const absolute = safeNormalize($(a).attr('href'), finalUrl);
    if (!absolute) return;
    discovered.add(absolute);
    if (sameDomain(absolute, rootHost)) internalLinks += 1;
    else externalLinks += 1;
  });

  return { page: { ...base, statusCode, contentType, score: scoreFromIssues(issues), title, titleLen: title?.length || 0, metaDescription, metaDescriptionLen: metaDescription?.length || 0, h1Count: h1s.length, h1Text: h1s.slice(0, 3).join(' | '), canonical, robotsMeta, noindex: /noindex/i.test(robotsMeta), lang, viewport, wordCount, internalLinks, externalLinks, nofollowLinks, hreflangCount, images: images.length, imagesMissingAlt, imagesEmptyAlt, linksWithoutText, structuredDataBlocks, structuredDataTypes, invalidJsonLd, ogTitle: Boolean(ogTitle), ogDescription: Boolean(ogDescription), mixedContent, issues, issueSummary: issues.map(i => i.message).join('; ') }, discovered };
}

function enrichDuplicates(pages) {
  for (const [field, label] of [['title', 'Duplicate title'], ['metaDescription', 'Duplicate meta description'], ['h1Text', 'Duplicate H1']]) {
    const map = new Map();
    pages.forEach(p => {
      const value = (p[field] || '').trim().toLowerCase();
      if (value) map.set(value, [...(map.get(value) || []), p]);
    });
    for (const group of map.values()) {
      if (group.length > 1) group.forEach(p => addIssue(p.issues, `duplicate_${field}`, field === 'title' ? 'medium' : 'low', `${label} (${group.length} pages)`, 'Metadata'));
    }
  }
  pages.forEach(p => {
    p.score = scoreFromIssues(p.issues || []);
    p.issueSummary = (p.issues || []).map(i => i.message).join('; ');
  });
}

function buildSummary(pages, links) {
  const issueCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const categoryCounts = {};
  for (const p of pages) for (const i of p.issues || []) {
    issueCounts[i.severity] = (issueCounts[i.severity] || 0) + 1;
    categoryCounts[i.category] = (categoryCounts[i.category] || 0) + 1;
  }
  const brokenLinks = links.filter(l => ['critical', 'high'].includes(l.linkSeverity)).length;
  const redirectedLinks = links.filter(l => l.redirectCount > 0).length;
  const responsePages = pages.filter(p => p.responseMs);
  return { checkedPages: pages.length, pagesWithIssues: pages.filter(p => p.issueSummary).length, uniqueLinks: new Set(links.map(l => l.targetUrl)).size, internalLinks: links.filter(l => l.type === 'internal').length, externalLinks: links.filter(l => l.type === 'external').length, brokenLinks, redirectedLinks, averageResponseMs: Math.round(responsePages.reduce((a, p) => a + p.responseMs, 0) / Math.max(1, responsePages.length)), averageScore: Math.round(pages.reduce((a, p) => a + (p.score || 0), 0) / Math.max(1, pages.length)), issueCounts, categoryCounts };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { startUrl = 'https://www.mangoproductdesign.com/', maxPages = 150, maxDepth = 4, timeout = 10, includeExternal = true, includeInternalStatus = true, concurrency = 4 } = req.body || {};
  try {
    const start = normalizeUrl(startUrl);
    const rootHost = new URL(start).hostname.toLowerCase();
    const queue = [{ url: start, depth: 0 }];
    const seen = new Set();
    const pages = [];
    const linkMap = new Map();
    const linksToCheck = new Map();

    while (queue.length && pages.length < Number(maxPages)) {
      const { url, depth } = queue.shift();
      if (seen.has(url) || depth > Number(maxDepth)) continue;
      seen.add(url);
      const { page, discovered } = await auditPage(url, rootHost, Number(timeout), depth);
      pages.push(page);
      for (const link of [...discovered].sort()) {
        const internal = sameDomain(link, rootHost);
        const key = `${url}||${link}`;
        if (!linkMap.has(key)) linkMap.set(key, { sourceUrl: url, targetUrl: link, type: internal ? 'internal' : 'external', sourceDepth: depth });
        if (internal && !seen.has(link) && !SKIP_EXTENSIONS.test(new URL(link).pathname) && depth + 1 <= Number(maxDepth) && pages.length + queue.length < Number(maxPages)) queue.push({ url: link, depth: depth + 1 });
        if ((!internal && includeExternal) || (internal && includeInternalStatus)) linksToCheck.set(link, internal ? 'internal' : 'external');
      }
    }

    const links = [...linkMap.values()];
    if (linksToCheck.size) {
      const limit = pLimit(Math.max(1, Math.min(Number(concurrency) || 4, 8)));
      const checks = await Promise.all([...linksToCheck.entries()].map(([link, type]) => limit(() => checkLink(link, Number(timeout), type))));
      const byUrl = new Map(checks.map(c => [c.targetUrl, c]));
      for (const row of links) if (byUrl.has(row.targetUrl)) Object.assign(row, byUrl.get(row.targetUrl));
    }

    const incoming = new Map();
    links.filter(l => l.type === 'internal').forEach(l => incoming.set(l.targetUrl, (incoming.get(l.targetUrl) || 0) + 1));
    pages.forEach(p => { p.inlinks = incoming.get(p.url) || incoming.get(p.finalUrl) || 0; if (p.depth > 0 && p.inlinks === 0) addIssue(p.issues, 'no_inlinks_recorded', 'low', 'No inlinks recorded during crawl', 'Internal linking'); });
    enrichDuplicates(pages);
    res.json({ pages, links, summary: buildSummary(pages, links), generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
}
