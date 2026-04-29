import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

const DEFAULT_UA = 'ManGoSEOAuditor/3.0 GEO-LLM (+https://www.mangoproductdesign.com/)';
const AI_BOTS = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'Google-Extended', 'PerplexityBot', 'ClaudeBot', 'Claude-User', 'anthropic-ai', 'Applebot-Extended', 'CCBot'];
const ENTITY_SCHEMA_TYPES = ['Organization', 'LocalBusiness', 'ProfessionalService', 'Corporation', 'Product', 'Service', 'Article', 'BlogPosting', 'FAQPage', 'HowTo', 'Person', 'WebSite', 'WebPage', 'BreadcrumbList'];
const CITATION_MARKERS = ['bron', 'source', 'case study', 'project', 'klant', 'expertise', 'ervaring', 'bewijs', 'faq', 'veelgestelde', 'specificaties', 'stappenplan'];
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
  } catch { return null; }
}

function sameDomain(url, rootHost) {
  const host = new URL(url).hostname.toLowerCase();
  const root = rootHost.replace(/^www\./, '');
  return host === rootHost || host === root || host.endsWith('.' + root);
}

function issue(code, severity, message, category = 'Technical SEO') { return { code, severity, message, category }; }
function addIssue(list, code, severity, message, category) { if (!list.some(i => i.code === code && i.message === message)) list.push(issue(code, severity, message, category)); }
function scoreFromIssues(issues) { const penalty = issues.reduce((sum, i) => sum + (i.severity === 'critical' ? 18 : i.severity === 'high' ? 10 : i.severity === 'medium' ? 5 : 2), 0); return Math.max(0, Math.min(100, 100 - penalty)); }
function statusSeverity(status) { if (!status) return 'critical'; if (status >= 500) return 'critical'; if (status >= 400) return 'high'; if (status >= 300) return 'medium'; return 'ok'; }

async function request(url, timeoutSec, method = 'GET', redirect = 'manual') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const start = performance.now();
  try {
    const res = await fetch(url, { method, redirect, signal: controller.signal, headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    return { res, responseMs: Math.round(performance.now() - start), error: null };
  } catch (err) {
    return { res: null, responseMs: Math.round(performance.now() - start), error: err.name === 'AbortError' ? 'Request timed out' : (err.message || String(err)) };
  } finally { clearTimeout(timer); }
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
    } catch { invalid += 1; }
  });
  const typeList = [...new Set(blocks.flatMap(t => String(t).split(',').map(x => x.trim()).filter(Boolean)))];
  const entityTypes = typeList.filter(t => ENTITY_SCHEMA_TYPES.some(known => known.toLowerCase() === t.toLowerCase()));
  return { structuredDataTypes: typeList.join(', '), structuredDataTypeList: typeList, entitySchemaTypes: [...new Set(entityTypes)].join(', '), invalidJsonLd: invalid, count: $('script[type*="ld+json" i]').length };
}

function textHasAny(text, needles) { const hay = String(text || '').toLowerCase(); return needles.some(n => hay.includes(n.toLowerCase())); }
function countElements($, selectors) { return selectors.reduce((sum, selector) => sum + $(selector).length, 0); }

function detectLlmSignals($, text, url) {
  const schema = extractJsonLd($);
  const authorSignals = countElements($, ['[rel="author"]', '[itemprop="author"]', '.author', '.byline', '[class*="author" i]', '[class*="expert" i]', '[class*="team" i]']);
  const updatedSignals = countElements($, ['time[datetime]', '[itemprop="dateModified"]', '[itemprop="datePublished"]', '[class*="updated" i]', '[class*="date" i]']);
  const faqSignals = $('h2,h3').filter((_, el) => /faq|veelgestelde|vragen/i.test($(el).text())).length + $('[itemscope][itemtype*="FAQPage"], [itemtype*="Question"]').length;
  const externalCitations = $('a[href]').filter((_, a) => { const href = $(a).attr('href') || ''; try { return new URL(href, url).hostname !== new URL(url).hostname && !/^(mailto:|tel:)/i.test(href); } catch { return false; } }).length;
  const known = ENTITY_SCHEMA_TYPES.map(x => x.toLowerCase());
  const hasEntitySchema = schema.structuredDataTypeList.some(t => known.includes(String(t).toLowerCase()));
  const directAnswerCandidates = $('p,li').filter((_, el) => { const len = $(el).text().replace(/\s+/g, ' ').trim().length; return len >= 80 && len <= 450; }).length;
  return { authorSignals, updatedSignals, faqSignals, tableCount: $('table').length, listCount: $('ul,ol').length, headings: $('h2,h3').length, externalCitations, hasEntitySchema, hasAboutMentions: textHasAny(text, ['ManGo', 'product design', 'productontwikkeling', 'engineering', 'prototype', 'prototyping']), hasCitationMarkers: textHasAny(text, CITATION_MARKERS), directAnswerCandidates, ...schema };
}

async function fetchTextAsset(url, timeoutSec) {
  const { res, error, responseMs, finalUrl, redirectChain } = await fetchWithRedirects(url, timeoutSec, 'GET');
  if (error || !res) return { url, ok: false, statusCode: null, error: error || 'No response', content: '', responseMs, finalUrl, redirectCount: redirectChain.length };
  const content = await res.text().catch(() => '');
  return { url, ok: res.status >= 200 && res.status < 400, statusCode: res.status, error: '', content, responseMs, finalUrl, redirectCount: redirectChain.length };
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
  if (error || !res) { addIssue(issues, 'fetch_error', 'critical', `Fetch error: ${error}`, 'Crawlability'); return { page: { ...base, statusCode: null, contentType: null, score: 0, issues, issueSummary: issues.map(i => i.message).join('; ') }, discovered }; }
  const statusCode = res.status;
  const contentType = res.headers.get('content-type') || '';
  if (statusCode >= 400) addIssue(issues, 'http_error', statusSeverity(statusCode), `HTTP ${statusCode}`, 'Crawlability');
  if (redirectChain.length === 1) addIssue(issues, 'redirect', 'medium', 'Page redirects', 'Crawlability');
  if (redirectChain.length > 1) addIssue(issues, 'redirect_chain', 'high', `Redirect chain (${redirectChain.length})`, 'Crawlability');
  if (!finalUrl.startsWith('https://')) addIssue(issues, 'not_https', 'high', 'Not HTTPS', 'Security');
  if (responseMs > 2000) addIssue(issues, 'slow', 'medium', 'Slow response >2s', 'Performance');
  if (responseMs > 4000) addIssue(issues, 'very_slow', 'high', 'Very slow response >4s', 'Performance');
  if (!contentType.toLowerCase().includes('text/html')) return { page: { ...base, statusCode, contentType, score: scoreFromIssues(issues), issues, issueSummary: issues.map(i => i.message).join('; ') }, discovered };

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
  const llmSignals = detectLlmSignals($, text, finalUrl);
  const { structuredDataTypes, invalidJsonLd, count: structuredDataBlocks, entitySchemaTypes } = llmSignals;

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
  if (!llmSignals.hasEntitySchema) addIssue(issues, 'llm_missing_entity_schema', 'medium', 'Missing entity-focused schema for LLM understanding', 'GEO / LLM');
  if (!llmSignals.hasAboutMentions && depth === 0) addIssue(issues, 'llm_weak_brand_entity', 'medium', 'Weak brand/entity context on landing page', 'GEO / LLM');
  if (wordCount >= 250 && llmSignals.headings < 2) addIssue(issues, 'llm_weak_structure', 'low', 'Content has few scannable H2/H3 sections', 'GEO / LLM');
  if (wordCount >= 300 && llmSignals.directAnswerCandidates < 2) addIssue(issues, 'llm_low_answer_extractability', 'low', 'Few concise answer-like paragraphs/list items', 'GEO / LLM');
  if (wordCount >= 350 && !llmSignals.hasCitationMarkers && llmSignals.externalCitations < 1) addIssue(issues, 'llm_low_citation_signals', 'low', 'Few evidence/citation signals for AI answers', 'GEO / LLM');
  if (wordCount >= 350 && llmSignals.authorSignals < 1) addIssue(issues, 'llm_missing_authority_signals', 'low', 'Missing visible author/expert/team signals', 'GEO / LLM');
  if (wordCount >= 350 && llmSignals.updatedSignals < 1) addIssue(issues, 'llm_missing_freshness_signals', 'low', 'Missing visible publish/update date signals', 'GEO / LLM');
  if (wordCount >= 500 && llmSignals.faqSignals < 1) addIssue(issues, 'llm_no_faq_section', 'low', 'No FAQ/question-answer section detected', 'GEO / LLM');

  let internalLinks = 0; let externalLinks = 0;
  $('a[href]').each((_, a) => { const absolute = safeNormalize($(a).attr('href'), finalUrl); if (!absolute) return; discovered.add(absolute); if (sameDomain(absolute, rootHost)) internalLinks += 1; else externalLinks += 1; });
  const llmAnswerabilityScore = Math.max(0, Math.min(100, 100 - (issues.filter(i => i.category === 'GEO / LLM').length * 12)));
  return { page: { ...base, statusCode, contentType, score: scoreFromIssues(issues), title, titleLen: title?.length || 0, metaDescription, metaDescriptionLen: metaDescription?.length || 0, h1Count: h1s.length, h1Text: h1s.slice(0, 3).join(' | '), canonical, robotsMeta, noindex: /noindex/i.test(robotsMeta), lang, viewport, wordCount, internalLinks, externalLinks, nofollowLinks, hreflangCount, images: images.length, imagesMissingAlt, imagesEmptyAlt, linksWithoutText, structuredDataBlocks, structuredDataTypes, invalidJsonLd, ogTitle: Boolean(ogTitle), ogDescription: Boolean(ogDescription), mixedContent, llmAnswerabilityScore, entitySchemaTypes, authorSignals: llmSignals.authorSignals, updatedSignals: llmSignals.updatedSignals, faqSignals: llmSignals.faqSignals, directAnswerCandidates: llmSignals.directAnswerCandidates, externalCitations: llmSignals.externalCitations, llmHeadings: llmSignals.headings, llmTables: llmSignals.tableCount, llmLists: llmSignals.listCount, issues, issueSummary: issues.map(i => i.message).join('; ') }, discovered };
}

function enrichDuplicates(pages) {
  for (const [field, label] of [['title', 'Duplicate title'], ['metaDescription', 'Duplicate meta description'], ['h1Text', 'Duplicate H1']]) {
    const map = new Map();
    pages.forEach(p => { const value = (p[field] || '').trim().toLowerCase(); if (value) map.set(value, [...(map.get(value) || []), p]); });
    for (const group of map.values()) if (group.length > 1) group.forEach(p => addIssue(p.issues, `duplicate_${field}`, field === 'title' ? 'medium' : 'low', `${label} (${group.length} pages)`, 'Metadata'));
  }
  pages.forEach(p => { p.score = scoreFromIssues(p.issues || []); p.issueSummary = (p.issues || []).map(i => i.message).join('; '); });
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function parseRobotsForAi(robotsText) {
  const botRules = {};
  for (const bot of AI_BOTS) {
    const regex = new RegExp('user-agent:\\s*' + escapeRegExp(bot) + '[\\s\\S]*?(?=user-agent:|$)', 'i');
    const block = regex.exec(robotsText || '');
    const segment = block ? block[0].toLowerCase() : '';
    botRules[bot] = { mentioned: Boolean(block), disallowAll: /disallow:\s*\//i.test(segment) };
  }
  const sitemapCount = (String(robotsText || '').match(/^sitemap:/gim) || []).length;
  const aiBotsMentioned = Object.values(botRules).filter(x => x.mentioned).length;
  const aiBotsBlocked = Object.values(botRules).filter(x => x.disallowAll).length;
  return { botRules, sitemapCount, aiBotsMentioned, aiBotsBlocked, hasAnyAiBotRule: aiBotsMentioned > 0, hasRobotsContent: String(robotsText || '').trim().length > 0 };
}

async function auditSiteLevel(start, timeoutSec) {
  const origin = new URL(start).origin;
  const [robotsAsset, llmsAsset] = await Promise.all([fetchTextAsset(origin + '/robots.txt', timeoutSec), fetchTextAsset(origin + '/llms.txt', timeoutSec)]);
  const robots = parseRobotsForAi(robotsAsset.content || '');
  const checks = [];
  if (!robotsAsset.ok) checks.push(issue('robots_missing_or_unreachable', 'medium', 'robots.txt missing or unreachable', 'Crawlability'));
  if (robots.hasRobotsContent && !robots.sitemapCount) checks.push(issue('robots_no_sitemap', 'low', 'robots.txt has no Sitemap directive', 'GEO / LLM'));
  if (robots.aiBotsBlocked > 0) checks.push(issue('robots_blocks_ai_bots', 'high', robots.aiBotsBlocked + ' AI crawler user-agent(s) appear blocked', 'GEO / LLM'));
  if (!robots.hasAnyAiBotRule) checks.push(issue('robots_no_ai_policy', 'low', 'No explicit AI crawler policy in robots.txt', 'GEO / LLM'));
  if (!llmsAsset.ok) checks.push(issue('llms_txt_missing', 'medium', 'llms.txt missing or unreachable', 'GEO / LLM'));
  else { const c = llmsAsset.content || ''; if (c.length < 200) checks.push(issue('llms_txt_thin', 'low', 'llms.txt exists but looks thin', 'GEO / LLM')); if (!/##|#/.test(c)) checks.push(issue('llms_txt_unstructured', 'low', 'llms.txt has little Markdown structure', 'GEO / LLM')); if (!/https?:\/\//i.test(c)) checks.push(issue('llms_txt_no_links', 'low', 'llms.txt has no absolute links to key pages', 'GEO / LLM')); }
  return { robots: { ...robotsAsset, ...robots, contentPreview: (robotsAsset.content || '').slice(0, 1200) }, llmsTxt: { ...llmsAsset, contentPreview: (llmsAsset.content || '').slice(0, 1200) }, checks };
}

function computeGeoSummary(pages, siteChecks) {
  const geoIssues = [...pages.flatMap(p => (p.issues || []).filter(i => i.category === 'GEO / LLM')), ...(siteChecks?.checks || []).filter(i => i.category === 'GEO / LLM')];
  const indexablePages = pages.filter(p => !p.noindex && p.statusCode && p.statusCode < 400);
  const avgAnswerability = Math.round(indexablePages.reduce((a, p) => a + (p.llmAnswerabilityScore || 0), 0) / Math.max(1, indexablePages.length));
  const withEntitySchema = pages.filter(p => p.entitySchemaTypes).length;
  const withFaq = pages.filter(p => (p.faqSignals || 0) > 0).length;
  const withAuthority = pages.filter(p => (p.authorSignals || 0) > 0).length;
  const withFreshness = pages.filter(p => (p.updatedSignals || 0) > 0).length;
  const llms = siteChecks?.llmsTxt || {}; const robots = siteChecks?.robots || {};
  const sitePenalty = (!llms.ok ? 12 : 0) + (robots.aiBotsBlocked ? 15 : 0) + (!robots.sitemapCount ? 6 : 0);
  const score = Math.max(0, Math.min(100, avgAnswerability - Math.round(geoIssues.length / Math.max(1, pages.length)) * 3 - sitePenalty));
  return { score, avgAnswerability, geoIssueCount: geoIssues.length, withEntitySchema, withFaq, withAuthority, withFreshness, llmsTxtFound: Boolean(llms.ok), robotsAiBotsBlocked: robots.aiBotsBlocked || 0, robotsAiBotsMentioned: robots.aiBotsMentioned || 0, robotsSitemaps: robots.sitemapCount || 0 };
}

function buildSummary(pages, links, siteChecks) {
  const issueCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const categoryCounts = {};
  for (const p of pages) for (const i of p.issues || []) { issueCounts[i.severity] = (issueCounts[i.severity] || 0) + 1; categoryCounts[i.category] = (categoryCounts[i.category] || 0) + 1; }
  for (const i of siteChecks?.checks || []) { issueCounts[i.severity] = (issueCounts[i.severity] || 0) + 1; categoryCounts[i.category] = (categoryCounts[i.category] || 0) + 1; }
  const brokenLinks = links.filter(l => ['critical', 'high'].includes(l.linkSeverity)).length;
  const redirectedLinks = links.filter(l => l.redirectCount > 0).length;
  const responsePages = pages.filter(p => p.responseMs);
  return { checkedPages: pages.length, geo: computeGeoSummary(pages, siteChecks), pagesWithIssues: pages.filter(p => p.issueSummary).length, uniqueLinks: new Set(links.map(l => l.targetUrl)).size, internalLinks: links.filter(l => l.type === 'internal').length, externalLinks: links.filter(l => l.type === 'external').length, brokenLinks, redirectedLinks, averageResponseMs: Math.round(responsePages.reduce((a, p) => a + p.responseMs, 0) / Math.max(1, responsePages.length)), averageScore: Math.round(pages.reduce((a, p) => a + (p.score || 0), 0) / Math.max(1, pages.length)), issueCounts, categoryCounts };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const { startUrl = 'https://www.mangoproductdesign.com/', maxPages = 150, maxDepth = 4, timeout = 10, includeExternal = true, includeInternalStatus = true, concurrency = 4 } = req.body || {};
  try {
    const start = normalizeUrl(startUrl);
    const rootHost = new URL(start).hostname.toLowerCase();
    const siteChecks = await auditSiteLevel(start, Number(timeout));
    const queue = [{ url: start, depth: 0 }];
    const seen = new Set(); const pages = []; const linkMap = new Map(); const linksToCheck = new Map();
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
    res.json({ pages, links, siteChecks, summary: buildSummary(pages, links, siteChecks), generatedAt: new Date().toISOString() });
  } catch (err) { res.status(400).json({ error: err.message || String(err) }); }
}
