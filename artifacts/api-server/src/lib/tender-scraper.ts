import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";
import { extractUnsuccessfulSuppliers } from "./pdf-extractor";

const BASE_URL = "https://www.find-tender.service.gov.uk";
const MIN_VALUE = 5_000_000;

async function httpGet(url: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
        timeout: 20000,
      });
      return res.data as string;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error("httpGet failed after retries");
}

function formatDateParam(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}%2F${mm}%2F${yyyy}`;
}

function parseGBP(text: string): number | null {
  // Handles: £5,000,000 / £5,000,000.00 / £5M
  const cleaned = text.replace(/,/g, "").trim();
  const match = cleaned.match(/£\s*([\d.]+)\s*([MmKk]?)/);
  if (!match) return null;
  let val = parseFloat(match[1]);
  if (isNaN(val)) return null;
  const suffix = match[2].toUpperCase();
  if (suffix === "M") val *= 1_000_000;
  else if (suffix === "K") val *= 1_000;
  return val;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  noticeId: string;
  noticeUrl: string;
  title: string;
  buyerName: string | null;
  awardedValue: number | null;
  publishedDate: string | null;
  stage: "award";
}

export interface TenderDetail {
  buyerName: string | null;
  description: string | null;
  awardedValue: number | null;
  pdfUrl: string | null;
  htmlSuppliers: string[];
  rawText: string;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Search Find a Tender for UK6 (Contract Award Notice) results.
 * Parses the correct dt/dd structure and filters to:
 *   - Notice type: UK6 only
 *   - Value: >= £5,000,000 (skips if value is known to be below)
 */
export async function searchAwardedTenders(
  keyword: string,
  days: number = 1,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const dateFrom = formatDateParam(from);
  const dateTo = formatDateParam(to);

  for (let page = 1; page <= 10; page++) {
    const url =
      `${BASE_URL}/Search/Results` +
      `?KeyWord=${encodeURIComponent(keyword)}` +
      `&NoticeStatus=6` +
      `&PublishedFrom=${dateFrom}` +
      `&PublishedTo=${dateTo}` +
      `&SortBy=3` +
      `&Page=${page}`;

    logger.info({ url }, "Searching Find a Tender");

    let html: string;
    try {
      html = await httpGet(url);
    } catch (err) {
      logger.error({ err, url }, "Search request failed");
      break;
    }

    const $ = cheerio.load(html);
    const $main = $("main").length ? $("main") : $("body");

    // Each result has an h3 with a Notice link — find the containing element
    const containers = $main.find("h3:has(a[href*='/Notice/'])").map((_i, el) => $(el).parent());

    if (containers.length === 0) {
      logger.info({ page }, "No more results — stopping");
      break;
    }

    let found = 0;

    containers.each((_i, container) => {
      const $c = $(container);

      // Parse all dt→dd pairs into a map
      const fields: Record<string, string> = {};
      $c.find("dt").each((_j, dt) => {
        const key = $(dt).text().trim().toLowerCase();
        const val = $(dt).next("dd").text().trim();
        fields[key] = val;
      });

      // Must be UK6
      const noticeType = (fields["notice type"] ?? "").toLowerCase();
      if (!noticeType.includes("uk6")) return;

      // Extract value and apply £5M filter
      const rawValue =
        fields["contract value including vat"] ??
        fields["contract value"] ??
        fields["value"] ??
        "";
      const awardedValue = parseGBP(rawValue);
      if (awardedValue !== null && awardedValue < MIN_VALUE) {
        logger.debug({ awardedValue, title: $c.find("h3 a").text().trim() }, "Skipping — below £5M");
        return;
      }

      // Get the notice link
      const $link = $c.find("a[href*='/Notice/']").first();
      const href = $link.attr("href") ?? "";
      if (!href) return;

      const noticeId = href.split("/Notice/")[1]?.split("?")[0];
      if (!noticeId || seen.has(noticeId)) return;
      seen.add(noticeId);

      results.push({
        noticeId,
        noticeUrl: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title: $link.text().trim(),
        buyerName: fields["contracting organization"] ?? fields["buyer"] ?? null,
        awardedValue,
        publishedDate: fields["publication date"] ?? null,
        stage: "award",
      });
      found++;
    });

    logger.info({ page, found }, "Parsed results page");
    if (found === 0) break;
  }

  logger.info({ total: results.length }, "Search complete");
  return results;
}

// ─── Detail ───────────────────────────────────────────────────────────────────

/**
 * Fetch a notice detail page and extract:
 * - buyer name, description, value
 * - PDF/document download links
 * - Unsuccessful suppliers from HTML text (if present)
 */
export async function fetchTenderDetail(noticeUrl: string): Promise<TenderDetail> {
  try {
    const html = await httpGet(noticeUrl);
    const $ = cheerio.load(html);

    const $main = $("main").length ? $("main") : $("body");
    const rawText = $main.text().replace(/\s+/g, " ");

    // Value from dt/dd
    let awardedValue: number | null = null;
    $("dt").each((_i, el) => {
      if (awardedValue !== null) return;
      const label = $(el).text().toLowerCase();
      if (label.includes("value") || label.includes("contract value")) {
        const v = parseGBP($(el).next("dd").text());
        if (v !== null) awardedValue = v;
      }
    });

    // Buyer from dt/dd
    let buyerName: string | null = null;
    $("dt").each((_i, el) => {
      if (buyerName) return;
      const label = $(el).text().toLowerCase();
      if (label.includes("authority") || label.includes("buyer") || label.includes("organisation") || label.includes("organization")) {
        buyerName = $(el).next("dd").text().trim() || null;
      }
    });

    // Description
    const description = $main.find("p").first().text().trim() || null;

    // PDF/document links — cast a wide net
    let pdfUrl: string | null = null;
    const docSelectors = [
      "a[href$='.pdf']",
      "a[href*='/documents/']",
      "a[href*='/Documents/']",
      "a[href*='document']",
      "a[href*='attachment']",
    ];
    for (const sel of docSelectors) {
      const href = $(sel).first().attr("href");
      if (href) {
        pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
        break;
      }
    }

    // Also look for links whose text suggests a downloadable document
    if (!pdfUrl) {
      $("a").each((_i, el) => {
        if (pdfUrl) return;
        const text = $(el).text().toLowerCase();
        const href = $(el).attr("href") ?? "";
        if ((text.includes("download") || text.includes("document") || text.includes("pdf")) && href) {
          pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
        }
      });
    }

    // Extract unsuccessful suppliers from HTML text as a best-effort fallback
    const htmlSuppliers = extractUnsuccessfulSuppliers(rawText);

    logger.info(
      { noticeUrl, awardedValue, hasPdf: !!pdfUrl, htmlSuppliers: htmlSuppliers.length },
      "Fetched tender detail",
    );

    return { buyerName, description, awardedValue, pdfUrl, htmlSuppliers, rawText: rawText.slice(0, 100_000) };
  } catch (err) {
    logger.warn({ err, noticeUrl }, "Failed to fetch tender detail");
    return { buyerName: null, description: null, awardedValue: null, pdfUrl: null, htmlSuppliers: [], rawText: "" };
  }
}
