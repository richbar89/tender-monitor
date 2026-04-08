import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";

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

const VALID_STAGES = ["award", "contract", "awarded", "contracted"];

function normalizeStage(stage: string): string {
  return stage.toLowerCase().trim();
}

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
            "Mozilla/5.0 (compatible; TenderTracker/1.0; +https://replit.com)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
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

export async function searchTenders(
  keyword: string,
  minValue: number = 5_000_000,
  stages: string[] = ["award", "contract", "awarded", "contracted"],
): Promise<ScrapedTender[]> {
  const results: ScrapedTender[] = [];

  const normalizedStages = stages.map(normalizeStage);
  const validStages = normalizedStages.filter((s) => VALID_STAGES.includes(s));

  // Find a Tender uses status parameters: awarded = 4, contract = 5
  // We search with keyword "Framework" and filter for award/contract notices
  const stageToParam: Record<string, string> = {
    award: "4",
    awarded: "4",
    contract: "5",
    contracted: "5",
  };

  // Collect unique stage params
  const stageParams = [
    ...new Set(
      validStages.map((s) => stageToParam[s]).filter(Boolean),
    ),
  ];

  if (stageParams.length === 0) {
    // Default: both award and contract stages
    stageParams.push("4", "5");
  }

  // Try both stage values
  for (const stageParam of stageParams) {
    try {
      const url = `${BASE_URL}/Search/Results?KeyWord=${encodeURIComponent(keyword)}&NoticeStatus=${stageParam}&SortBy=3&Page=1&SearchType=0`;
      logger.info({ url }, "Fetching search results page");

      const html = await fetchWithRetry(url);
      const $ = cheerio.load(html);

      // Parse search results - Find a Tender uses specific HTML structure
      const tenderItems = $(".search-result-entry, article.notice-item, .search-results li");

      tenderItems.each((_i, el) => {
        try {
          const $el = $(el);

          // Extract title and link
          const titleEl = $el.find("h2 a, h3 a, .notice-title a, a.govuk-link").first();
          const title = titleEl.text().trim();
          const href = titleEl.attr("href");

          if (!title || !href) return;

          const noticeUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
          const noticeId = href.split("/").pop()?.split("?")[0] ?? href;

          // Extract stage/type
          const stageText = $el
            .find(".notice-type, .search-result-type, [data-notice-type]")
            .text()
            .toLowerCase();
          const procurementStage =
            stageParam === "4" ? "award" : "contract";

          // Extract value
          const valueText = $el
            .find(".value, .contract-value, [data-value]")
            .text();
          const awardedValue = parseValue(valueText);

          // Apply value filter
          if (awardedValue !== null && awardedValue < minValue) return;

          // Extract buyer
          const buyerName = $el
            .find(".buyer-name, .contracting-authority, .organisation")
            .text()
            .trim() || null;

          // Extract date
          const publishedDate = $el
            .find(".published-date, time, .date")
            .first()
            .text()
            .trim() || null;

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
        } catch (err) {
          logger.warn({ err }, "Failed to parse tender item");
        }
      });

      // If no results from .search-result-entry, try alternative parsing
      if (results.length === 0) {
        await parseAlternativeFormat($, results, stageParam, minValue);
      }
    } catch (err) {
      logger.error({ err, stageParam }, "Failed to fetch search results");
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

async function parseAlternativeFormat(
  $: cheerio.CheerioAPI,
  results: ScrapedTender[],
  stageParam: string,
  minValue: number,
): Promise<void> {
  // Try broader selectors used by the GOV.UK service
  $("ul.app-results li, .app-result-item, [data-result]").each((_i, el) => {
    const $el = $(el);
    const titleEl = $el.find("a").first();
    const title = titleEl.text().trim();
    const href = titleEl.attr("href");
    if (!title || !href) return;

    const noticeUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    const noticeId = href.split("/").filter(Boolean).pop() ?? href;
    const procurementStage = stageParam === "4" ? "award" : "contract";

    const valueText = $el.find("dd, .value").text();
    const awardedValue = parseValue(valueText);
    if (awardedValue !== null && awardedValue < minValue) return;

    results.push({
      noticeId,
      title,
      description: null,
      buyerName: $el.find("dd:nth-of-type(2), .authority").text().trim() || null,
      awardedValue,
      currency: "GBP",
      procurementStage,
      publishedDate: $el.find("time, .date").text().trim() || null,
      noticeUrl,
      pdfUrl: null,
    });
  });
}

export async function fetchTenderDetail(
  noticeUrl: string,
): Promise<Partial<ScrapedTender>> {
  try {
    const html = await fetchWithRetry(noticeUrl);
    const $ = cheerio.load(html);

    const description =
      $(".notice-description, .summary, [data-description]").text().trim() ||
      null;

    const buyerName =
      $(".contracting-authority, .buyer-name, .organisation-name")
        .first()
        .text()
        .trim() || null;

    const valueText =
      $(".contract-value, .awarded-value, [data-value]").first().text() || "";
    const awardedValue = parseValue(valueText);

    // Look for PDF links
    const pdfUrl =
      $("a[href$='.pdf'], a[href*='/documents/'], a:contains('PDF')")
        .first()
        .attr("href") || null;

    const absolutePdfUrl = pdfUrl
      ? pdfUrl.startsWith("http")
        ? pdfUrl
        : `${BASE_URL}${pdfUrl}`
      : null;

    return {
      description,
      buyerName,
      awardedValue,
      pdfUrl: absolutePdfUrl,
    };
  } catch (err) {
    logger.warn({ err, noticeUrl }, "Failed to fetch tender detail page");
    return {};
  }
}
