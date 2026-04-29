import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import { AlertTriangle, Bot, CheckCircle2, Download, FileText, Filter, Gauge, Link2, Play, Search, ShieldAlert } from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, ok: 4 };

function flattenPage(page) {
  const { issues = [], ...rest } = page;
  return { ...rest, issueCount: issues.length, critical: issues.filter(i => i.severity === 'critical').length, high: issues.filter(i => i.severity === 'high').length, medium: issues.filter(i => i.severity === 'medium').length, low: issues.filter(i => i.severity === 'low').length, issues: issues.map(i => `${i.severity.toUpperCase()}: ${i.message}`).join(' | ') };
}

function downloadCsv(rows, filename) {
  const csv = Papa.unparse(rows || []);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function IssuePills({ issues = [], limit = 5 }) {
  if (!issues.length) return <span className="pill ok"><CheckCircle2 size={12}/> OK</span>;
  return issues.slice(0, limit).map((issue) => <span className={`pill ${issue.severity}`} key={`${issue.code}-${issue.message}`}>{issue.severity}: {issue.message}</span>);
}

function Score({ value }) {
  const className = value >= 85 ? 'good' : value >= 65 ? 'warn' : 'badscore';
  return <span className={`score ${className}`}>{value ?? '-'}</span>;
}

function App() {
  const [form, setForm] = useState({
    startUrl: 'https://www.mangoproductdesign.com/',
    maxPages: 150,
    maxDepth: 4,
    timeout: 10,
    concurrency: 4,
    includeExternal: true,
    includeInternalStatus: true,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('issues');
  const [severity, setSeverity] = useState('all');

  const pages = result?.pages || [];
  const links = result?.links || [];
  const siteChecks = result?.siteChecks || null;
  const summary = result?.summary;

  const issueRows = useMemo(() => [
    ...(siteChecks?.checks || []).map((i) => ({ url: 'Site-level', score: summary?.geo?.score, statusCode: '-', title: 'GEO/LLM site check', ...i })),
    ...pages.flatMap((p) => (p.issues || []).map((i) => ({ url: p.url, score: p.score, statusCode: p.statusCode, title: p.title, ...i })))
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]), [pages, siteChecks, summary]);

  const filteredPages = useMemo(() => {
    const q = query.toLowerCase().trim();
    return pages.filter((p) => {
      const matchesQuery = !q || `${p.url} ${p.title || ''} ${p.issueSummary || ''}`.toLowerCase().includes(q);
      const matchesSeverity = severity === 'all' || (p.issues || []).some(i => i.severity === severity);
      return matchesQuery && matchesSeverity;
    });
  }, [pages, query, severity]);

  const filteredLinks = useMemo(() => {
    const q = query.toLowerCase().trim();
    return links.filter((l) => {
      const matchesQuery = !q || `${l.sourceUrl} ${l.targetUrl} ${l.type} ${l.statusCode || ''} ${l.linkIssue || ''} ${l.error || ''}`.toLowerCase().includes(q);
      const matchesSeverity = severity === 'all' || l.linkSeverity === severity;
      return matchesQuery && matchesSeverity;
    }).sort((a, b) => SEVERITY_ORDER[a.linkSeverity || 'ok'] - SEVERITY_ORDER[b.linkSeverity || 'ok']);
  }, [links, query, severity]);

  const filteredIssues = useMemo(() => {
    const q = query.toLowerCase().trim();
    return issueRows.filter((i) => {
      const matchesQuery = !q || `${i.url} ${i.message} ${i.category} ${i.severity}`.toLowerCase().includes(q);
      const matchesSeverity = severity === 'all' || i.severity === severity;
      return matchesQuery && matchesSeverity;
    });
  }, [issueRows, query, severity]);

  async function runAudit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch(`${API_BASE}/api/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Audit failed');
      setResult(data);
      setTab('issues');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <section className="hero">
        <div className="hero-inner">
          <div className="eyebrow">ManGo Product Design · Technical SEO</div>
          <h1>Technical SEO Auditor</h1>
          <p>Crawl jullie website, prioriteer technische SEO én GEO/LLM issues: AI-crawlbaarheid, llms.txt, robots-regels voor AI-bots, entity schema, answerability, authority/freshness-signalen en citeerbare content.</p>
        </div>
      </section>

      <main className="container">
        <form className="panel" onSubmit={runAudit}>
          <div className="grid">
            <div className="field url">
              <label>Start URL</label>
              <input value={form.startUrl} onChange={(e) => setForm({ ...form, startUrl: e.target.value })} placeholder="https://www.example.com/" />
            </div>
            <div className="field small">
              <label>Max pagina's</label>
              <input type="number" min="1" max="1000" value={form.maxPages} onChange={(e) => setForm({ ...form, maxPages: Number(e.target.value) })} />
            </div>
            <div className="field small">
              <label>Max diepte</label>
              <input type="number" min="0" max="8" value={form.maxDepth} onChange={(e) => setForm({ ...form, maxDepth: Number(e.target.value) })} />
            </div>
            <div className="field small">
              <label>Timeout sec</label>
              <input type="number" min="2" max="30" value={form.timeout} onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })} />
            </div>
            <div className="field small">
              <label>Concurrency</label>
              <input type="number" min="1" max="8" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })} />
            </div>
            <label className="check"><input type="checkbox" checked={form.includeExternal} onChange={(e) => setForm({ ...form, includeExternal: e.target.checked })} /> Externe links checken</label>
            <label className="check"><input type="checkbox" checked={form.includeInternalStatus} onChange={(e) => setForm({ ...form, includeInternalStatus: e.target.checked })} /> Interne links status checken</label>
          </div>
          <div className="actions">
            <button className="button primary" disabled={loading}><Play size={16}/>{loading ? 'Audit draait…' : 'Start audit'}</button>
            {pages.length > 0 && <button type="button" className="button secondary" onClick={() => downloadCsv(pages.map(flattenPage), 'technical_seo_pages.csv')}><Download size={16}/>Pages CSV</button>}
            {pages.length > 0 && <button type="button" className="button secondary" onClick={() => downloadCsv(pages.map(p => ({ url: p.url, llmAnswerabilityScore: p.llmAnswerabilityScore, entitySchemaTypes: p.entitySchemaTypes, authorSignals: p.authorSignals, updatedSignals: p.updatedSignals, faqSignals: p.faqSignals, directAnswerCandidates: p.directAnswerCandidates, externalCitations: p.externalCitations, geoIssues: (p.issues || []).filter(i => i.category === 'GEO / LLM').map(i => i.message).join(' | ') })), 'geo_llm_pages.csv')}><Download size={16}/>GEO CSV</button>}
            {issueRows.length > 0 && <button type="button" className="button secondary" onClick={() => downloadCsv(issueRows, 'technical_seo_issues.csv')}><Download size={16}/>Issues CSV</button>}
            {links.length > 0 && <button type="button" className="button secondary" onClick={() => downloadCsv(links, 'technical_seo_links.csv')}><Download size={16}/>Links CSV</button>}
          </div>
          {loading && <div className="progress"><div className="bar" /></div>}
          {error && <p className="error"><AlertTriangle size={16}/> {error}</p>}
          <p className="footer-note">Vercel serverless functies hebben een runtime-limiet. Voor grote sites: verlaag concurrency of crawl in batches per subfolder.</p>
        </form>

        {summary && (
          <>
            <section className="summary">
              <div className="card"><Gauge size={18}/><div className="label">Gem. SEO score</div><div className="metric">{summary.averageScore}</div></div>
              <div className="card"><ShieldAlert size={18}/><div className="label">Critical / High</div><div className="metric">{summary.issueCounts.critical || 0}/{summary.issueCounts.high || 0}</div></div>
              <div className="card"><Link2 size={18}/><div className="label">Broken links</div><div className="metric">{summary.brokenLinks}</div></div>
              <div className="card"><Bot size={18}/><div className="label">GEO/LLM score</div><div className="metric">{summary.geo?.score ?? '-'}</div></div>
              <div className="card"><div className="label">Pagina's / links</div><div className="metric">{summary.checkedPages}/{summary.uniqueLinks}</div></div>
            </section>
            <section className="breakdown panel">
              {Object.entries(summary.categoryCounts || {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => <span className="category" key={name}>{name}: <strong>{count}</strong></span>)}
            </section>
          </>
        )}

        <div className="toolbar">
          <div className="tabs">
            <button className={`tab ${tab === 'issues' ? 'active' : ''}`} onClick={() => setTab('issues')}>Issues</button>
            <button className={`tab ${tab === 'pages' ? 'active' : ''}`} onClick={() => setTab('pages')}>Pages audit</button>
            <button className={`tab ${tab === 'links' ? 'active' : ''}`} onClick={() => setTab('links')}>Links</button>
            <button className={`tab ${tab === 'geo' ? 'active' : ''}`} onClick={() => setTab('geo')}>GEO / LLM</button>
          </div>
          <div className="filters">
            <div className="field inline"><label><Filter size={14}/> Severity</label><select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="all">Alle</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
            <div className="field inline"><label><Search size={14}/> Filter</label><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek op URL, issue, status…" /></div>
          </div>
        </div>

        {!result && !loading && <div className="empty panel">Vul de start-URL in en klik op Start audit.</div>}

        {result && tab === 'issues' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Severity</th><th>Categorie</th><th>Issue</th><th>URL</th><th>Score</th><th>Status</th></tr></thead>
              <tbody>{filteredIssues.map((i, n) => <tr key={`${i.url}-${i.code}-${n}`}><td><span className={`pill ${i.severity}`}>{i.severity}</span></td><td>{i.category}</td><td>{i.message}</td><td className="url">{i.url}</td><td><Score value={i.score}/></td><td>{i.statusCode || '-'}</td></tr>)}</tbody>
            </table>
          </div>
        )}

        {result && tab === 'pages' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Score</th><th>URL</th><th>Status</th><th>Resp.</th><th>Title</th><th>Meta</th><th>H1</th><th>Links</th><th>Schema</th><th>Issues</th></tr></thead>
              <tbody>{filteredPages.map((p) => <tr key={p.url}><td><Score value={p.score}/></td><td className="url">{p.url}</td><td>{p.statusCode || '-'}</td><td>{p.responseMs ? `${p.responseMs} ms` : '-'}</td><td>{p.title || '-'}<br/><small>{p.titleLen || 0} chars</small></td><td>{p.metaDescription || '-'}<br/><small>{p.metaDescriptionLen || 0} chars</small></td><td>{p.h1Count ?? '-'}<br/><small>{p.h1Text}</small></td><td>{p.internalLinks ?? 0} int / {p.externalLinks ?? 0} ext<br/><small>{p.inlinks ?? 0} inlinks</small></td><td>{p.structuredDataBlocks ?? 0}<br/><small>{p.structuredDataTypes || '-'}</small></td><td><IssuePills issues={p.issues}/></td></tr>)}</tbody>
            </table>
          </div>
        )}

        {result && tab === 'geo' && (
          <div className="geo-grid">
            <section className="panel geo-panel">
              <h2><Bot size={18}/> GEO / LLM summary</h2>
              <div className="summary mini">
                <div className="card"><div className="label">GEO score</div><div className="metric">{summary.geo?.score ?? '-'}</div></div>
                <div className="card"><div className="label">Answerability</div><div className="metric">{summary.geo?.avgAnswerability ?? '-'}</div></div>
                <div className="card"><div className="label">llms.txt</div><div className="metric">{summary.geo?.llmsTxtFound ? 'OK' : 'Mist'}</div></div>
                <div className="card"><div className="label">AI bots blocked</div><div className="metric">{summary.geo?.robotsAiBotsBlocked ?? 0}</div></div>
              </div>
              <div className="breakdown inline-blocks">
                <span className="category">Entity schema: <strong>{summary.geo?.withEntitySchema ?? 0}/{summary.checkedPages}</strong></span>
                <span className="category">FAQ signals: <strong>{summary.geo?.withFaq ?? 0}</strong></span>
                <span className="category">Authority signals: <strong>{summary.geo?.withAuthority ?? 0}</strong></span>
                <span className="category">Freshness signals: <strong>{summary.geo?.withFreshness ?? 0}</strong></span>
                <span className="category">robots sitemaps: <strong>{summary.geo?.robotsSitemaps ?? 0}</strong></span>
                <span className="category">AI bot policies: <strong>{summary.geo?.robotsAiBotsMentioned ?? 0}</strong></span>
              </div>
            </section>
            <section className="panel geo-panel">
              <h2><FileText size={18}/> Site-level checks</h2>
              <table>
                <thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead>
                <tbody>
                  <tr><td>robots.txt</td><td>{siteChecks?.robots?.statusCode || '-'}</td><td>{siteChecks?.robots?.ok ? 'Bereikbaar' : siteChecks?.robots?.error || 'Niet bereikbaar'} · {siteChecks?.robots?.sitemapCount || 0} Sitemap directives</td></tr>
                  <tr><td>llms.txt</td><td>{siteChecks?.llmsTxt?.statusCode || '-'}</td><td>{siteChecks?.llmsTxt?.ok ? 'Bereikbaar' : siteChecks?.llmsTxt?.error || 'Niet bereikbaar'}</td></tr>
                  {(siteChecks?.checks || []).map((c) => <tr key={c.code}><td><span className={`pill ${c.severity}`}>{c.severity}</span></td><td>{c.category}</td><td>{c.message}</td></tr>)}
                </tbody>
              </table>
            </section>
            <div className="table-wrap wide">
              <table>
                <thead><tr><th>LLM score</th><th>URL</th><th>Entity schema</th><th>Authority</th><th>Freshness</th><th>FAQ</th><th>Answer blocks</th><th>Citations</th><th>GEO issues</th></tr></thead>
                <tbody>{filteredPages.map((p) => <tr key={p.url}><td><Score value={p.llmAnswerabilityScore}/></td><td className="url">{p.url}</td><td>{p.entitySchemaTypes || '-'}</td><td>{p.authorSignals ?? 0}</td><td>{p.updatedSignals ?? 0}</td><td>{p.faqSignals ?? 0}</td><td>{p.directAnswerCandidates ?? 0}</td><td>{p.externalCitations ?? 0}</td><td><IssuePills issues={(p.issues || []).filter(i => i.category === 'GEO / LLM')} /></td></tr>)}</tbody>
              </table>
            </div>
          </div>
        )}

        {result && tab === 'links' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Severity</th><th>Bron</th><th>Doel</th><th>Type</th><th>Status</th><th>Redirects</th><th>Final URL</th><th>Issue/Error</th></tr></thead>
              <tbody>{filteredLinks.map((l, i) => <tr key={`${l.sourceUrl}-${l.targetUrl}-${i}`}><td><span className={`pill ${l.linkSeverity || 'ok'}`}>{l.linkSeverity || 'ok'}</span></td><td className="url">{l.sourceUrl}</td><td className="url">{l.targetUrl}</td><td>{l.type}</td><td>{l.statusCode || (l.skipped ? 'skipped' : '-')}</td><td>{l.redirectCount ?? '-'}</td><td className="url">{l.finalUrl || '-'}</td><td>{l.linkIssue || l.error || '-'}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
