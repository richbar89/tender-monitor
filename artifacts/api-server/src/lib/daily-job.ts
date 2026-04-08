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
  pdfsProcessed: number;
  pdpsFailed: number;
  unsuccessfulBiddersByContract: Record<string, string[]>;
}> {
  logger.info("Daily job started");

  let newTenders = 0;
  let pdfsProcessed = 0;
  let pdfsFailed = 0;
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

  // Step 3: Find all tenders that haven't had their PDF processed yet
  const unprocessed = await db
    .select()
    .from(tendersTable)
    .where(
      or(
        eq(tendersTable.pdfStatus, "none"),
        eq(tendersTable.pdfStatus, "failed"),
      ),
    );

  logger.info({ count: unprocessed.length }, "Tenders pending PDF processing");

  // Step 4: For each unprocessed tender, fetch detail page if no PDF URL, then process PDF
  for (const tender of unprocessed) {
    let pdfUrl = tender.pdfUrl;

    // Fetch detail page to find PDF URL if missing
    if (!pdfUrl) {
      try {
        const detail = await fetchTenderDetail(tender.noticeUrl);
        pdfUrl = detail.pdfUrl ?? null;

        if (pdfUrl || detail.description || detail.buyerName || detail.awardedValue) {
          await db
            .update(tendersTable)
            .set({
              pdfUrl: pdfUrl ?? tender.pdfUrl,
              description: detail.description ?? tender.description,
              buyerName: detail.buyerName ?? tender.buyerName,
              awardedValue: detail.awardedValue?.toString() ?? tender.awardedValue,
            })
            .where(eq(tendersTable.id, tender.id));
        }
      } catch (err) {
        logger.warn({ err, tenderId: tender.id }, "Failed to fetch tender detail page");
      }
    }

    if (!pdfUrl) {
      await db
        .update(tendersTable)
        .set({ pdfStatus: "failed" })
        .where(eq(tendersTable.id, tender.id));
      pdfsFailed++;
      continue;
    }

    // Process the PDF
    try {
      await db
        .update(tendersTable)
        .set({ pdfStatus: "downloading" })
        .where(eq(tendersTable.id, tender.id));

      const result = await extractPdfData(pdfUrl);

      await db
        .update(tendersTable)
        .set({
          pdfStatus: "processed",
          rawPdfText: result.text.slice(0, 100_000),
          unsuccessfulSuppliers: result.unsuccessfulSuppliers,
        })
        .where(eq(tendersTable.id, tender.id));

      pdfsProcessed++;

      if (result.unsuccessfulSuppliers.length > 0) {
        unsuccessfulBiddersByContract[tender.title] = result.unsuccessfulSuppliers;
        logger.info(
          { tenderId: tender.id, title: tender.title, count: result.unsuccessfulSuppliers.length },
          "Unsuccessful suppliers found",
        );
      }
    } catch (err) {
      logger.error({ err, tenderId: tender.id }, "Failed to process PDF");
      await db
        .update(tendersTable)
        .set({ pdfStatus: "failed" })
        .where(eq(tendersTable.id, tender.id));
      pdfsFailed++;
    }
  }

  logger.info(
    { newTenders, pdfsProcessed, pdfsFailed, contracts: Object.keys(unsuccessfulBiddersByContract).length },
    "Daily job completed",
  );

  return { newTenders, pdfsProcessed, pdpsFailed: pdfsFailed, unsuccessfulBiddersByContract };
}
