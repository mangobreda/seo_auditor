# Technical SEO + GEO/LLM Auditor

React + Vercel serverless app voor het crawlen van een website en het vinden van technische SEO, link-health en GEO/LLM issues.

## Checks

- HTTP status, redirects en redirect chains
- Broken interne/externe links
- Title, meta description, H1, canonical, robots meta
- Structured data / JSON-LD validatie
- Open Graph, viewport, lang, mixed content, image alt, empty links
- Duplicate titles, meta descriptions en H1's
- Internal link metrics en inlinks
- GEO/LLM checks:
  - `/llms.txt` aanwezigheid en basisstructuur
  - `robots.txt` + AI crawler regels voor o.a. GPTBot, ChatGPT-User, OAI-SearchBot, Google-Extended, ClaudeBot en PerplexityBot
  - Entity schema zoals Organization, LocalBusiness, Product, Service, FAQPage en Article
  - Answerability score per pagina
  - Author/expert/team signalen
  - Publicatie/update datum signalen
  - FAQ, heading, lijst/tabel en citation/evidence signalen

## Lokaal runnen

```bash
npm install
npm run dev
```

Open daarna de URL die Vercel CLI toont.

## Deploy naar Vercel

1. Push deze map naar GitHub.
2. Importeer de repo in Vercel.
3. Framework preset: Vite.
4. Build command: `npm run build`.
5. Output directory: `dist`.

## Let op

Vercel serverless functies hebben runtime-limieten. Voor grote sites kun je beter met lagere `maxPages`, lagere concurrency of per subfolder crawlen.
