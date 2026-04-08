import { eq, or } from "drizzle-orm";
import { db, tendersTable } from "@workspace/db";
import { searchTenders, fetchTenderDetail } from "./tender-scraper";
import { extractPdfData } from "./pdf-extractor";
import { logger } from "./logger";

const SEARCH_KEYWORD = "Framework";
const MIN_VALUE = 5_000_000;
const STAGES = ["award", "contract", "awarded", "contracted"];

export async function runDailyJob(): Promise<{
  newTenders: number;
  processed: number;
  failed: number;
  unsuccessfulBiddersByContract: Record<string, string[]>;
}> {
  logger.info("Daily job started");

  let newTenders = 0;
  let processed = 0;
  let failed = 0;
  const unsuccessfulBiddersByContract: Record<string, string[]> = {};

  // Step 1: Scrape new tenders
  let scraped;
  try {
    scraped = await searchTenders(SEARCH_KEYWORD, MIN_VALUE, STAGES, 3);
    logger.info({ count: scraped.length }, "Scraped tenders from Find a Tender");
  } catch (err) {
    logger.error({ err }, "Failed to scrape tenders — aborting daily job");
    throw err;
  }

  // Step 2: Insert new tenders (skip duplicates)
  for (const tender of scraped) {
    try {
      const existing = await db
        .select({ id: tendersTable.id })
        .from(tendersTable)
        .where(eq(tendersTable.noticeId, tender.noticeId))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(tendersTable).values({
          noticeId: tender.noticeId,
          title: tender.title,
          description: tender.description,
          buyerName: tender.buyerName,
          awardedValue: tender.awardedValue?.toString() ?? null,
          currency: tender.currency,
          procurementStage: tender.procurementStage,
          publishedDate: tender.publishedDate,
          noticeUrl: tender.noticeUrl,
          pdfUrl: tender.pdfUrl,
          pdfStatus: "none",
          unsuccessfulSuppliers: [],
        });
        newTenders++;
        logger.info({ noticeId: tender.noticeId }, "Inserted new tender");
      }
    } catch (err) {
      logger.warn({ err, noticeId: tender.noticeId }, "Failed to upsert tender");
    }
  }

  // Step 3: Find all tenders that haven't been analysed yet
  const unprocessed = await db
    .select()
    .from(tendersTable)
    .where(
      or(
        eq(tendersTable.pdfStatus, "none"),
        eq(tendersTable.pdfStatus, "failed"),
      ),
    );

  logger.info({ count: unprocessed.length }, "Tenders pending analysis");

  // Step 4: For each unprocessed tender, fetch the notice page and extract supplier info
  for (const tender of unprocessed) {
    try {
      await db
        .update(tendersTable)
        .set({ pdfStatus: "downloading" })
        .where(eq(tendersTable.id, tender.id));

      // Always fetch the detail page — extracts suppliers from HTML AND finds PDF URL
      const detail = await fetchTenderDetail(tender.noticeUrl);

      // Update metadata from detail page
      await db
        .update(tendersTable)
        .set({
          pdfUrl: detail.pdfUrl ?? tender.pdfUrl,
          description: detail.description ?? tender.description,
          buyerName: detail.buyerName ?? tender.buyerName,
          awardedValue: detail.awardedValue?.toString() ?? tender.awardedValue,
        })
        .where(eq(tendersTable.id, tender.id));

      let suppliers: string[] = detail.htmlSuppliers ?? [];
      let rawText: string = detail.htmlText ?? "";

      // If a PDF was found, also try extracting from it (may yield more structured results)
      const pdfUrl = detail.pdfUrl ?? tender.pdfUrl;
      if (pdfUrl) {
        try {
          const pdfResult = await extractPdfData(pdfUrl);
          if (pdfResult.unsuccessfulSuppliers.length > 0) {
            suppliers = pdfResult.unsuccessfulSuppliers;
          }
          rawText = pdfResult.text.slice(0, 100_000);
          logger.info({ tenderId: tender.id, count: suppliers.length }, "Extracted from PDF");
        } catch (pdfErr) {
          logger.warn({ pdfErr, tenderId: tender.id }, "PDF extraction failed, using HTML results");
        }
      }

      await db
        .update(tendersTable)
        .set({
          pdfStatus: "processed",
          rawPdfText: rawText,
          unsuccessfulSuppliers: suppliers,
        })
        .where(eq(tendersTable.id, tender.id));

      processed++;

      if (suppliers.length > 0) {
        unsuccessfulBiddersByContract[tender.title] = suppliers;
        logger.info(
          { tenderId: tender.id, title: tender.title, count: suppliers.length },
          "Unsuccessful suppliers found",
        );
      } else {
        logger.info({ tenderId: tender.id }, "No unsuccessful suppliers found in this notice");
      }
    } catch (err) {
      logger.error({ err, tenderId: tender.id }, "Failed to analyse tender");
      await db
        .update(tendersTable)
        .set({ pdfStatus: "failed" })
        .where(eq(tendersTable.id, tender.id));
      failed++;
    }
  }

  logger.info(
    { newTenders, processed, failed, contracts: Object.keys(unsuccessfulBiddersByContract).length },
    "Daily job completed",
  );

  return { newTenders, processed, failed, unsuccessfulBiddersByContract };
}
