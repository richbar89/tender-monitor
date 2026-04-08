import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";
import { extractUnsuccessfulSuppliers } from "./pdf-extractor";

const BASE_URL = "https://www.find-tender.service.gov.uk";

// NoticeStatus codes to search — we cast a wide net and filter to UK6 titles after
const AWARD_STATUS_CODES = ["4", "5", "6", "7"];

function formatDateParam(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}%2F${mm}%2F${yyyy}`;
}

function parseGBP(text: string): number | null {
  const match = text.replace(/,/g, "").match(/£\s*([\d.]+)/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  return isNaN(val) ? null : val;
}

async function httpGet(url: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        timeout: 15000,
      });
      return res.data as string;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error("httpGet failed after retries");
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  noticeId: string;
  noticeUrl: string;
  title: string;
  stage: "award" | "contract";
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
 * Search Find a Tender for awarded contracts published in the last `days` days.
 * Uses keyword "Framework", NoticeStatus 4 (Award Notice) and 5 (Contract Award Notice).
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

  for (const status of AWARD_STATUS_CODES) {
    for (let page = 1; page <= 10; page++) {
      const url =
        `${BASE_URL}/Search/Results` +
        `?KeyWord=${encodeURIComponent(keyword)}` +
        `&NoticeStatus=${status}` +
        `&PublishedFrom=${dateFrom}` +
        `&PublishedTo=${dateTo}` +
        `&SortBy=3` +
        `&Page=${page}`;

      logger.info({ url }, "Searching Find a Tender");

      let html: string;
      try {
        html = await httpGet(url);
      } catch (err) {
        logger.error({ err, url }, "Search page request failed");
        break;
      }

      const $ = cheerio.load(html);
      // Only look inside the main content area
      const $main = $("main").length ? $("main") : $("body");
      const links = $main.find("a[href*='/Notice/']");

      if (links.length === 0) {
        logger.info({ status, page }, "No more results");
        break;
      }

      let found = 0;
      links.each((_i, el) => {
        const href = $(el).attr("href") ?? "";
        const title = $(el).text().trim();

        if (!href.match(/\/Notice\/[\w-]+/) || title.length < 5) return;

        // Only accept UK6 (Contract Award Notice)
        const ukTypeMatch = title.match(/^(UK\d+):/i);
        if (ukTypeMatch) {
          if (ukTypeMatch[1].toUpperCase() !== "UK6") return;
        }

        const noticeId = href.split("/Notice/")[1]?.split("?")[0];
        if (!noticeId || seen.has(noticeId)) return;
        seen.add(noticeId);

        results.push({
          noticeId,
          noticeUrl: href.startsWith("http") ? href : `${BASE_URL}${href}`,
          title,
          stage: status === "4" ? "award" : "contract",
        });
        found++;
      });

      logger.info({ status, page, found }, "Parsed results page");
      if (found === 0) break;
    }
  }

  return results;
}

// ─── Detail ───────────────────────────────────────────────────────────────────

/**
 * Fetch a notice detail page and extract:
 * - buyer name, value, description
 * - PDF link (if any)
 * - Unsuccessful suppliers from the HTML text
 */
export async function fetchTenderDetail(noticeUrl: string): Promise<TenderDetail> {
  try {
    const html = await httpGet(noticeUrl);
    const $ = cheerio.load(html);

    // Extract all text from the notice for supplier analysis
    const rawText = $("main, body").text().replace(/\s+/g, " ");

    // Value — find first £ amount in a <dd>
    let awardedValue: number | null = null;
    $("dd").each((_i, el) => {
      if (awardedValue !== null) return;
      const v = parseGBP($(el).text());
      if (v !== null) awardedValue = v;
    });

    // Buyer — find <dt> containing "authority", "buyer", or "organisation", then read the next <dd>
    let buyerName: string | null = null;
    $("dt").each((_i, el) => {
      if (buyerName) return;
      const label = $(el).text().toLowerCase();
      if (label.includes("authority") || label.includes("buyer") || label.includes("organisation")) {
        buyerName = $(el).next("dd").text().trim() || null;
      }
    });

    // Description
    const description = $(".govuk-body, p").first().text().trim() || null;

    // PDF link
    let pdfUrl: string | null =
      $("a[href$='.pdf'], a[href*='/documents/'], a[href*='Documents']").first().attr("href") ?? null;
    if (pdfUrl && !pdfUrl.startsWith("http")) pdfUrl = `${BASE_URL}${pdfUrl}`;

    // Extract unsuccessful suppliers from the HTML text
    const htmlSuppliers = extractUnsuccessfulSuppliers(rawText);

    logger.info(
      { noticeUrl, awardedValue, htmlSuppliers: htmlSuppliers.length, hasPdf: !!pdfUrl },
      "Fetched tender detail",
    );

    return {
      buyerName,
      description,
      awardedValue,
      pdfUrl,
      htmlSuppliers,
      rawText: rawText.slice(0, 100_000),
    };
  } catch (err) {
    logger.warn({ err, noticeUrl }, "Failed to fetch tender detail");
    return { buyerName: null, description: null, awardedValue: null, pdfUrl: null, htmlSuppliers: [], rawText: "" };
  }
}
