import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";
import { extractUnsuccessfulSuppliers } from "./pdf-extractor";

export interface ScrapedTender {
  noticeId: string;
  title: string;
  description: string | null;
  buyerName: string | null;
  awardedValue: number | null;
  currency: string;
  procurementStage: string;
  publishedDate: string | null;
  noticeUrl: string;
  pdfUrl: string | null;
}

const BASE_URL = "https://www.find-tender.service.gov.uk";

function parseValue(valueStr: string | null): number | null {
  if (!valueStr) return null;
  const cleaned = valueStr.replace(/[£,\s]/g, "").replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

async function fetchWithRetry(url: string, retries = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
        },
        timeout: 15000,
      });
      return response.data as string;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error("Failed after retries");
}

function formatDateParam(date: Date): string {
  // Find a Tender uses DD/MM/YYYY format for date params
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}%2F${mm}%2F${yyyy}`;
}

export async function searchTenders(
  keyword: string,
  minValue: number = 5_000_000,
  stages: string[] = ["award", "contract", "awarded", "contracted"],
  days: number = 3,
): Promise<ScrapedTender[]> {
  const results: ScrapedTender[] = [];

  // Date range: last N days up to today
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);

  const dateFrom = formatDateParam(fromDate);
  const dateTo = formatDateParam(toDate);

  // NoticeStatus: 4 = award notice, 5 = contract award notice
  const stageParams = ["4", "5"];

  for (const stageParam of stageParams) {
    for (let page = 1; page <= 5; page++) {
      try {
        const url =
          `${BASE_URL}/Search/Results` +
          `?KeyWord=${encodeURIComponent(keyword)}` +
          `&NoticeStatus=${stageParam}` +
          `&PublishedFrom=${dateFrom}` +
          `&PublishedTo=${dateTo}` +
          `&SortBy=3` +
          `&Page=${page}` +
          `&SearchType=0`;

        logger.info({ url }, "Fetching search results page");
        const html = await fetchWithRetry(url);
        const $ = cheerio.load(html);

        // Primary strategy: find all notice links directly — most reliable approach
        // Find a Tender notice URLs follow the pattern /Notice/{id}
        const noticeLinks = $("a[href*='/Notice/']");

        if (noticeLinks.length === 0) {
          logger.info({ url, page, stageParam }, "No notice links found on page — stopping pagination");
          break;
        }

        let pageResults = 0;

        noticeLinks.each((_i, el) => {
          const $el = $(el);
          const href = $el.attr("href");
          if (!href) return;

          // Skip non-notice links (e.g. pagination, breadcrumbs)
          if (!href.match(/\/Notice\/[\w-]+/)) return;

          const title = $el.text().trim();
          if (!title || title.length < 5) return;

          // Skip live/open tenders — we only want awarded contracts
          const titleLower = title.toLowerCase();
          if (
            titleLower.includes("prior information") ||
            titleLower.includes("contract notice") && !titleLower.includes("award") ||
            titleLower.includes("open procedure") ||
            titleLower.includes("invitation to tender")
          ) return;

          const noticeUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
          const noticeId = href.split("/Notice/")[1]?.split("?")[0] ?? href;
          const procurementStage = stageParam === "4" ? "award" : "contract";

          // Walk up to find the result container for metadata
          const $container = $el.closest("article, li, div.search-result, .govuk-grid-row, tr");

          const valueText = $container.find("dd, .value, [data-value]").filter((_i, el) => {
            return $(el).text().includes("£");
          }).first().text();
          const awardedValue = parseValue(valueText);

          // Apply value filter — skip only if value is known and below threshold
          if (awardedValue !== null && awardedValue < minValue) return;

          const buyerName =
            $container.find("dd, .authority, .buyer, .contracting-authority, .organisation").not((_i, el) => {
              return $(el).text().includes("£");
            }).first().text().trim() || null;

          const publishedDate =
            $container.find("time, .date, dd").filter((_i, el) => {
              return /\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2}/.test($(el).text());
            }).first().text().trim() || null;

          results.push({
            noticeId,
            title,
            description: null,
            buyerName,
            awardedValue,
            currency: "GBP",
            procurementStage,
            publishedDate,
            noticeUrl,
            pdfUrl: null,
          });

          pageResults++;
        });

        logger.info({ page, stageParam, pageResults }, "Parsed page results");

        // If we got fewer results than expected, we've hit the last page
        if (pageResults === 0) break;

      } catch (err) {
        logger.error({ err, stageParam, page }, "Failed to fetch search results page");
        break;
      }
    }
  }

  // Deduplicate by noticeId
  const seen = new Set<string>();
  return results.filter((t) => {
    if (seen.has(t.noticeId)) return false;
    seen.add(t.noticeId);
    return true;
  });
}

export interface TenderDetailResult extends Partial<ScrapedTender> {
  htmlSuppliers: string[];
  htmlText: string;
}

export async function fetchTenderDetail(
  noticeUrl: string,
): Promise<TenderDetailResult> {
  try {
    const html = await fetchWithRetry(noticeUrl);
    const $ = cheerio.load(html);

    const description =
      $(".notice-description, .summary, [data-description], .govuk-body").first().text().trim() ||
      null;

    const buyerName =
      $("dd").filter((_i, el) => {
        const prev = $(el).prev("dt").text().toLowerCase();
        return prev.includes("authority") || prev.includes("buyer") || prev.includes("organisation");
      }).first().text().trim() || null;

    const valueText =
      $("dd").filter((_i, el) => {
        return $(el).text().includes("£");
      }).first().text() || "";
    const awardedValue = parseValue(valueText);

    // Look for PDF / document links
    const pdfLink = $(
      "a[href$='.pdf'], a[href*='/documents/'], a[href*='assets.publishing'], a[href*='/Documents/']"
    ).first();
    const pdfUrl = pdfLink.attr("href") || null;
    const absolutePdfUrl = pdfUrl
      ? pdfUrl.startsWith("http") ? pdfUrl : `${BASE_URL}${pdfUrl}`
      : null;

    // Extract all visible text from the page and parse for unsuccessful suppliers
    const pageText = $("body").text();
    const htmlSuppliers = extractUnsuccessfulSuppliers(pageText);

    logger.info(
      { noticeUrl, htmlSuppliers: htmlSuppliers.length, hasPdf: !!absolutePdfUrl },
      "Fetched tender detail",
    );

    return {
      description,
      buyerName,
      awardedValue,
      pdfUrl: absolutePdfUrl,
      htmlSuppliers,
      htmlText: pageText.slice(0, 100_000),
    };
  } catch (err) {
    logger.warn({ err, noticeUrl }, "Failed to fetch tender detail page");
    return { htmlSuppliers: [], htmlText: "" };
  }
}
