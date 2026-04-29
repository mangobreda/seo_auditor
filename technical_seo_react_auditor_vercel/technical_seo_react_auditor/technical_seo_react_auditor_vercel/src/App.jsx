import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import { Download, Play, Search, AlertTriangle, CheckCircle2 } from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';

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

function IssuePills({ issues }) {
  if (!issues) return <span className="pill ok"><CheckCircle2 size={12}/> OK</span>;
  return issues.split(';').filter(Boolean).slice(0, 5).map((issue) => <span className="pill bad" key={issue}>{issue.trim()}</span>);
}

function App() {
  const [form, setForm] = useState({
    startUrl: 'https://www.mangoproductdesign.com/',
    maxPages: 150,
    maxDepth: 4,
    timeout: 10,
    concurrency: 4,
    includeExternal: true,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('pages');

  const pages = result?.pages || [];
  const links = result?.links || [];
  const summary = result?.summary;

  const filteredPages = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return pages;
    return pages.filter((p) => `${p.url} ${p.title || ''} ${p.issues || ''}`.toLowerCase().includes(q));
  }, [pages, query]);

  const filteredLinks = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return links;
    return links.filter((l) => `${l.sourceUrl} ${l.targetUrl} ${l.type} ${l.statusCode || ''} ${l.error || ''}`.toLowerCase().includes(q));
  }, [links, query]);

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
          <h1>Technical SEO Link Auditor</h1>
          <p>Crawl jullie website, verzamel interne en externe links en check technische SEO-issues zoals broken links, redirects, titles, meta descriptions, H1s, canonicals, noindex, structured data en alt-teksten.</p>
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
              <input type="number" min="1" max="5000" value={form.maxPages} onChange={(e) => setForm({ ...form, maxPages: Number(e.target.value) })} />
            </div>
            <div className="field small">
              <label>Max diepte</label>
              <input type="number" min="0" max="10" value={form.maxDepth} onChange={(e) => setForm({ ...form, maxDepth: Number(e.target.value) })} />
            </div>
            <div className="field small">
              <label>Timeout sec</label>
              <input type="number" min="2" max="30" value={form.timeout} onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })} />
            </div>
            <div className="field small">
              <label>Concurrency</label>
              <input type="number" min="1" max="10" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })} />
            </div>
            <label className="check">
              <input type="checkbox" checked={form.includeExternal} onChange={(e) => setForm({ ...form, includeExternal: e.target.checked })} />
              Check externe links met HEAD/GET
            </label>
          </div>
          <div className="actions">
            <button className="button primary" disabled={loading}><Play size={16}/>{loading ? 'Audit draait…' : 'Start audit'}</button>
            {pages.length > 0 && <button type="button" className="button secondary" onClick={() => downloadCsv(pages, 'pages_audit.csv')}><Download size={16}/>Pages CSV</button>}
            {links.length > 0 && <button type="button" className="button secondary" onClick={() => downloadCsv(links, 'links_audit.csv')}><Download size={16}/>Links CSV</button>}
          </div>
          {loading && <div className="progress"><div className="bar" style={{ width: '70%' }}/></div>}
          {error && <p className="error"><AlertTriangle size={16}/> {error}</p>}
          <p className="footer-note">Omdat crawling server-side moet gebeuren, draait deze React frontend samen met een Vercel serverless API-route.</p>
        </form>

        {summary && (
          <section className="summary">
            <div className="card"><div className="label">Gecheckte pagina's</div><div className="metric">{summary.checkedPages}</div></div>
            <div className="card"><div className="label">Pagina's met issues</div><div className="metric">{summary.pagesWithIssues}</div></div>
            <div className="card"><div className="label">Gem. response ms</div><div className="metric">{summary.averageResponseMs}</div></div>
            <div className="card"><div className="label">Unieke links</div><div className="metric">{summary.uniqueLinks}</div></div>
          </section>
        )}

        <div className="toolbar">
          <div className="tabs">
            <button className={`tab ${tab === 'pages' ? 'active' : ''}`} onClick={() => setTab('pages')}>Pages audit</button>
            <button className={`tab ${tab === 'links' ? 'active' : ''}`} onClick={() => setTab('links')}>Gevonden links</button>
          </div>
          <div className="field">
            <label><Search size={14}/> Filter</label>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek op URL, issue, status…" />
          </div>
        </div>

        {!result && !loading && <div className="empty panel">Vul de start-URL in en klik op Start audit.</div>}

        {result && tab === 'pages' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>URL</th><th>Status</th><th>Response</th><th>Title</th><th>Meta</th><th>H1</th><th>Canonical</th><th>Words</th><th>Issues</th></tr></thead>
              <tbody>{filteredPages.map((p) => <tr key={p.url}><td className="url">{p.url}</td><td>{p.statusCode || '-'}</td><td>{p.responseMs ? `${p.responseMs} ms` : '-'}</td><td>{p.title || '-'}<br/><small>{p.titleLen || 0} chars</small></td><td>{p.metaDescription || '-'}<br/><small>{p.metaDescriptionLen || 0} chars</small></td><td>{p.h1Count ?? '-'}<br/><small>{p.h1Text}</small></td><td className="url">{p.canonical || '-'}</td><td>{p.wordCount ?? '-'}</td><td><IssuePills issues={p.issues}/></td></tr>)}</tbody>
            </table>
          </div>
        )}

        {result && tab === 'links' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Bron</th><th>Doel</th><th>Type</th><th>Status</th><th>Final URL</th><th>Error</th></tr></thead>
              <tbody>{filteredLinks.map((l, i) => <tr key={`${l.sourceUrl}-${l.targetUrl}-${i}`}><td className="url">{l.sourceUrl}</td><td className="url">{l.targetUrl}</td><td>{l.type}</td><td>{l.statusCode || '-'}</td><td className="url">{l.finalUrl || '-'}</td><td>{l.error || '-'}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
