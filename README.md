# Technical SEO Auditor — React + Vercel

React/Vite frontend met een Vercel serverless API crawler voor technische SEO-audits.

## Verbeteringen in deze versie

- Severity model: critical, high, medium, low
- SEO score per pagina en gemiddelde site-score
- Issues-tab met prioriteitenlijst
- CSV-export voor pages, issues en links
- Interne én externe link health checks
- Redirect chain detectie
- Duplicate title, meta description en H1-detectie
- Structured data detectie + invalid JSON-LD check
- Open Graph title/description check
- Mixed content check
- Accessibility checks: missing alt en links zonder toegankelijke tekst
- Internal linking metrics: internal links, external links en inlinks
- Betere filtering op severity en zoekterm

## Lokaal draaien

```bash
npm install
npm run dev
```

Open daarna de URL die `vercel dev` toont, meestal `http://localhost:3000`.

## Deploy naar Vercel

1. Upload deze map naar GitHub.
2. Importeer het project in Vercel.
3. Framework preset: Vite.
4. Build command: `npm run build`.
5. Output directory: `dist`.

De API route staat in `api/audit.js` en wordt door Vercel als serverless function gedeployed.

## Praktische limieten

Vercel serverless functies hebben runtime-limieten. Voor kleine en middelgrote sites werkt dit goed. Voor grote sites kun je beter crawlen per subfolder, `maxPages` lager zetten of de API als langere Node service draaien.
