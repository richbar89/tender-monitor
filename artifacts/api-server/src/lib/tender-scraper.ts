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
 * Search Find a Tender for awarded/contracted notices (UK6 or UK7).
 * Filters to:
 *   - Notice type: UK6 (Contract award notice) or UK7 (Contract details notice)
 *   - Value: >= £5,000,000 (skips if value is known to be below)
 */
export async function searchAwardedTenders(
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
      `?KeyWord=` +
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

    // Find all notice links — then walk up to get the result container for each
    const noticeLinks = $main.find("a[href*='/Notice/']");

    if (noticeLinks.length === 0) {
      logger.info({ page }, "No more results — stopping");
      break;
    }

    let found = 0;

    noticeLinks.each((_i, el) => {
      const $link = $(el);
      const href = $link.attr("href") ?? "";
      const title = $link.text().trim();

      // Must be a proper notice link with a reasonable title
      if (!href.match(/\/Notice\/[\w-]+/) || title.length < 5) return;

      // Walk up to find the result container (has a dl with dt/dd pairs)
      const $c = $link.closest("div, li, article");
      if (!$c.length || !$c.find("dl").length) return;

      // Parse all dt→dd pairs into a map
      const fields: Record<string, string> = {};
      $c.find("dt").each((_j, dt) => {
        const key = $(dt).text().trim().toLowerCase();
        const val = $(dt).next("dd").text().trim();
        fields[key] = val;
      });

      // Must be UK6 (contract award) or UK7 (contract details)
      const noticeType = (fields["notice type"] ?? "").toLowerCase();
      if (!noticeType.includes("uk6") && !noticeType.includes("uk7")) return;

      // Extract value and apply £5M filter
      const rawValue =
        fields["contract value including vat"] ??
        fields["contract value"] ??
        fields["value"] ??
        "";
      const awardedValue = parseGBP(rawValue);
      if (awardedValue !== null && awardedValue < MIN_VALUE) {
        logger.info({ awardedValue, title }, "Skipping — below £5M");
        return;
      }

      const noticeId = href.split("/Notice/")[1]?.split("?")[0];
      if (!noticeId || seen.has(noticeId)) return;
      seen.add(noticeId);

      results.push({
        noticeId,
        noticeUrl: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title,
        buyerName: fields["contracting organization"] ?? fields["buyer"] ?? null,
        awardedValue,
        publishedDate: fields["publication date"] ?? null,
        stage: "award",
      });
      found++;
    });

    logger.info({ page, found }, "Parsed results page");
    // Don't break on found === 0: with an empty keyword the page may contain
    // only non-UK6/UK7 notices while later pages still have hits. The
    // noticeLinks.length === 0 check above handles the true end-of-results.
  }

  logger.info({ total: results.length }, "Search complete");
  return results;
}

// ─── Detail ───────────────────────────────────────────────────────────────────

// Headings on UK6/UK7 notice pages we treat as the start of an unsuccessful-suppliers list.
// Examples seen in the wild: "Unsuccessful suppliers", "Unsuccessful bidders",
// "Unsuccessful tenderers". Match any of those nouns (plural or singular).
const UNSUCCESSFUL_HEADING_RE =
  /\bunsuccessful\s+(suppliers?|bidders?|tenderers?|contractors?|applicants?|participants?|economic\s+operators?)\b/i;

/**
 * Walk the parsed notice DOM and collect supplier names that sit under a heading
 * matching /unsuccessful (suppliers|bidders|tenderers|...)/.
 *
 * Find a Tender renders these as `<h4>…</h4><ul><li><a>NAME</a></li>…</ul>`,
 * which the flat-text regex extractor mangles because whitespace is collapsed.
 */
function extractUnsuccessfulSuppliersFromDom(
  $: cheerio.CheerioAPI,
): string[] {
  const found = new Set<string>();

  $("h1, h2, h3, h4, h5, h6").each((_i, heading) => {
    const headingText = $(heading).text().trim();
    if (!UNSUCCESSFUL_HEADING_RE.test(headingText)) return;

    // Walk siblings after the heading until the next heading, picking up
    // <li> items from any <ul>/<ol> in between (direct or nested wrapper).
    let node = $(heading).next();
    let safety = 0;
    while (node.length && safety < 10) {
      safety++;
      const tag = (node.prop("tagName") ?? "").toLowerCase();
      if (/^h[1-6]$/.test(tag)) break;

      const items =
        tag === "ul" || tag === "ol"
          ? node.children("li")
          : node.find("ul > li, ol > li");

      items.each((_j, li) => {
        // Supplier names on Find a Tender are usually wrapped in an <a> to an
        // in-page anchor; fall back to the <li>'s own text if there isn't one.
        const $li = $(li);
        const linkText = $li.find("a").first().text().trim();
        const name = (linkText || $li.text()).trim().replace(/\s+/g, " ");
        if (name.length >= 2 && name.length <= 200) found.add(name);
      });

      node = node.next();
    }
  });

  return Array.from(found);
}

/**
 * Fetch a notice detail page and extract:
 * - buyer name, description, value
 * - PDF/document download links
 * - Unsuccessful suppliers from the DOM (preferred) or HTML text (fallback)
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

    // Prefer structural DOM extraction (handles UK6/UK7 notice pages), then fall
    // back to the regex-on-text extractor for anything we miss.
    const domSuppliers = extractUnsuccessfulSuppliersFromDom($);
    const htmlSuppliers = domSuppliers.length > 0
      ? domSuppliers
      : extractUnsuccessfulSuppliers(rawText);

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
