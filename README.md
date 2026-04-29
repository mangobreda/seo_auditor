# Technical SEO Link Auditor — Vercel React App

React/Vite frontend met een Vercel Serverless Function voor crawling en technische SEO-checks.

## Deploy naar Vercel

1. Upload deze map naar GitHub, GitLab of Bitbucket.
2. Maak in Vercel een nieuw project aan en importeer de repository.
3. Vercel detecteert Vite automatisch.
4. Gebruik deze settings:
   - Build command: `npm run build`
   - Output directory: `dist`
   - Install command: `npm install`
5. Deploy.

De API-route staat op `/api/audit`.

## Lokaal draaien met Vercel CLI

```bash
npm install
npm run dev
```

Open daarna de URL die Vercel CLI toont, meestal `http://localhost:3000`.

## Wat wordt gecontroleerd?

- Interne en externe links
- HTTP-statussen, redirects en errors
- Response time
- Title length en ontbrekende titles
- Meta descriptions
- H1-count
- Canonical tags
- Noindex meta robots
- HTML lang en viewport
- Thin content-indicatie
- Afbeeldingen zonder alt
- JSON-LD structured data
- HTTPS
- CSV-export voor pages en links

## Belangrijke Vercel-limiet

Serverless functions hebben een maximale runtime. Houd `Max pagina's`, `Max diepte`, timeout en externe link-checks beperkt voor grote websites. Voor zeer grote crawls is een queue/worker of aparte server beter.
