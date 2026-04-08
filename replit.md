# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Artifacts

### Tender Tracker (artifacts/tender-tracker)
React + Vite web app for monitoring UK government framework contract awards.

**Features:**
- Scrapes https://www.find-tender.service.gov.uk/ for contracts with:
  - Keyword: "Framework"
  - Value: above £5,000,000
  - Procurement Stage: award / contract / awarded / contracted
- Downloads and parses PDFs associated with each tender
- Extracts "Unsuccessful Suppliers" from PDF text
- Dashboard with search controls, stats bar, and tender list
- Tender detail page with PDF processing status and supplier list

**Key files:**
- `artifacts/tender-tracker/src/` — React frontend
- `artifacts/api-server/src/routes/tenders.ts` — Tender API routes
- `artifacts/api-server/src/lib/tender-scraper.ts` — Web scraper (Cheerio)
- `artifacts/api-server/src/lib/pdf-extractor.ts` — PDF download & supplier extraction
- `lib/db/src/schema/tenders.ts` — Database schema

**Dependencies:**
- `axios` + `cheerio` — for web scraping Find a Tender
- `pdf-parse@1.1.1` — for extracting text from tender PDFs (externalized in build to avoid debug mode issue)

**Note on pdf-parse:** The `pdf-parse` package must be in the `external` list in `artifacts/api-server/build.mjs`. It is also imported via its internal lib path (`pdf-parse/lib/pdf-parse.js`) to avoid the debug mode check in `index.js`.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
