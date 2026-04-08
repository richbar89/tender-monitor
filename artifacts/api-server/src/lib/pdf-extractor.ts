import axios from "axios";
import { logger } from "./logger";

// Import the actual pdf-parse library directly, bypassing the index.js debug check
// The index.js has a debug mode that reads a test file at startup when module.parent is null
// We import the inner lib directly to avoid this issue
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  buffer: Buffer,
  options?: Record<string, unknown>,
) => Promise<{ text: string; numpages: number; info: Record<string, unknown> }>;

export interface PdfExtractionResult {
  text: string;
  unsuccessfulSuppliers: string[];
}

async function downloadPdf(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; TenderTracker/1.0; +https://replit.com)",
      Accept: "application/pdf,*/*",
    },
    maxContentLength: 50 * 1024 * 1024,
  });
  return Buffer.from(response.data as ArrayBuffer);
}

export async function extractPdfData(
  pdfUrl: string,
): Promise<PdfExtractionResult> {
  logger.info({ pdfUrl }, "Downloading PDF");
  const buffer = await downloadPdf(pdfUrl);

  logger.info({ pdfUrl, size: buffer.length }, "Parsing PDF");

  const data = await pdfParse(buffer);
  const text = data.text;

  const suppliers = extractUnsuccessfulSuppliers(text);

  return {
    text,
    unsuccessfulSuppliers: suppliers,
  };
}

export function extractUnsuccessfulSuppliers(text: string): string[] {
  const suppliers: Set<string> = new Set();

  // Patterns to find sections containing unsuccessful suppliers
  const sectionPatterns = [
    /unsuccessful(?:\s+tender(?:er)?s?|\s+bidder(?:s)?|\s+supplier(?:s)?|\s+contractor(?:s)?|\s+applicant(?:s)?)[\s\S]{0,2000}/gi,
    /(?:not\s+awarded|not\s+selected|failed\s+to\s+win|unsuccessful\s+(?:in\s+)?(?:the\s+)?(?:tender|bid|competition))[\s\S]{0,2000}/gi,
    /(?:tenderer(?:s)?\s+not\s+selected|bidder(?:s)?\s+not\s+selected)[\s\S]{0,2000}/gi,
    /(?:section\s+[IVX]+\s*[:\.]?\s*)?unsuccessful[\s\S]{0,2000}/gi,
  ];

  for (const pattern of sectionPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const section = match[0];
      extractNamesFromSection(section, suppliers);
    }
  }

  // Also look for award decision / evaluation tables
  const tablePatterns = [
    /(?:lot\s+\d+|framework)[\s\S]{0,500}(?:unsuccessful|not\s+awarded|rejected)[\s\S]{0,500}/gi,
    /(?:v\.2\.?\d*|award\s+information)[\s\S]{0,3000}/gi,
  ];

  for (const pattern of tablePatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const section = match[0];
      extractNamesFromSection(section, suppliers);
    }
  }

  return Array.from(suppliers).filter(
    (s) => s.length > 2 && s.length < 200,
  );
}

function extractNamesFromSection(section: string, suppliers: Set<string>): void {
  const lines = section.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const companySuffixPattern =
    /\b(?:ltd\.?|limited|plc|llp|llc|inc\.?|corp\.?|corporation|group|holdings?|international|consultants?|services?|solutions?|consulting|associates?|partners?|uk|gmbh|bv|ag|sa|sas|pty)\b/i;

  const skipPatterns = [
    /^(?:unsuccessful|not\s+selected|bidder|tenderer|supplier|contractor|name|company|organisation|section)/i,
    /^\d+$/,
    /^(?:page|ref|date|value|contract|award|lot)/i,
    /^[^a-zA-Z]+$/,
  ];

  for (const line of lines) {
    if (line.length < 3 || line.length > 200) continue;

    const shouldSkip = skipPatterns.some((p) => p.test(line));
    if (shouldSkip) continue;

    if (companySuffixPattern.test(line)) {
      const cleaned = cleanSupplierName(line);
      if (cleaned) suppliers.add(cleaned);
      continue;
    }

    const listMatch = line.match(
      /^(?:\d+[\.\)]\s*|[-•]\s*|[a-zA-Z][\.\)]\s*)(.+)$/,
    );
    if (listMatch) {
      const name = listMatch[1].trim();
      if (name.length > 3 && companySuffixPattern.test(name)) {
        const cleaned = cleanSupplierName(name);
        if (cleaned) suppliers.add(cleaned);
      }
    }
  }

  const inlineListPattern =
    /([A-Z][a-zA-Z\s&]+(?:Ltd|Limited|Plc|LLP|LLC|Inc|Corp|Group|Holdings?|International|Services?|Solutions?|Consulting|Consultants?)\.?)(?:\s*[,;]\s*|\s+and\s+)/g;
  const inlineMatches = section.matchAll(inlineListPattern);
  for (const match of inlineMatches) {
    const cleaned = cleanSupplierName(match[1]);
    if (cleaned) suppliers.add(cleaned);
  }
}

function cleanSupplierName(name: string): string {
  return name
    .replace(/[\[\]\(\)\{\}]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s&',\.\-]/g, "")
    .trim();
}
