import { eq, or } from "drizzle-orm";
import { db, tendersTable } from "@workspace/db";
import { searchAwardedTenders, fetchTenderDetail } from "./tender-scraper";
import { extractPdfData } from "./pdf-extractor";
import { logger } from "./logger";

const KEYWORD = "Framework";
const MIN_VALUE = 5_000_000;

export async function runDailyJob(days = 1): Promise<{
  newTenders: number;
  analysed: number;
  failed: number;
  results: Array<{ title: string; buyerName: string | null; unsuccessfulSuppliers: string[] }>;
}> {
  logger.info({ days }, "Daily job started");

  let newTenders = 0;
  let analysed = 0;
  let failed = 0;
  const results: Array<{ title: string; buyerName: string | null; unsuccessfulSuppliers: string[] }> = [];

  // ── Step 1: Search Find a Tender ──────────────────────────────────────────
  let scraped;
  try {
    scraped = await searchAwardedTenders(KEYWORD, days);
    logger.info({ count: scraped.length }, "Search complete");
  } catch (err) {
    logger.error({ err }, "Search failed — aborting job");
    throw err;
  }

  // ── Step 2: Insert new tenders, skip duplicates ────────────────────────────
  for (const s of scraped) {
    try {
      const existing = await db
        .select({ id: tendersTable.id })
        .from(tendersTable)
        .where(eq(tendersTable.noticeId, s.noticeId))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(tendersTable).values({
          noticeId: s.noticeId,
          title: s.title,
          description: null,
          buyerName: s.buyerName ?? null,
          awardedValue: s.awardedValue?.toString() ?? null,
          currency: "GBP",
          procurementStage: s.stage,
          publishedDate: s.publishedDate ?? null,
          noticeUrl: s.noticeUrl,
          pdfUrl: null,
          pdfStatus: "none",
          unsuccessfulSuppliers: [],
        });
        newTenders++;
      }
    } catch (err) {
      logger.warn({ err, noticeId: s.noticeId }, "Failed to insert tender");
    }
  }

  // ── Step 3: Analyse all unprocessed tenders ────────────────────────────────
  const unprocessed = await db
    .select()
    .from(tendersTable)
    .where(or(eq(tendersTable.pdfStatus, "none"), eq(tendersTable.pdfStatus, "failed")));

  logger.info({ count: unprocessed.length }, "Tenders to analyse");

  for (const tender of unprocessed) {
    try {
      // Mark as in-progress
      await db.update(tendersTable).set({ pdfStatus: "downloading" }).where(eq(tendersTable.id, tender.id));

      // Fetch the notice detail page
      const detail = await fetchTenderDetail(tender.noticeUrl);

      // Filter out tenders below £5M or where value can't be confirmed
      const confirmedValue = detail.awardedValue ?? (tender.awardedValue ? parseFloat(tender.awardedValue) : null);
      if (confirmedValue === null || confirmedValue < MIN_VALUE) {
        logger.info({ tenderId: tender.id, value: confirmedValue }, "Below £5M or unknown value — skipping");
        await db.update(tendersTable).set({ pdfStatus: "failed" }).where(eq(tendersTable.id, tender.id));
        failed++;
        continue;
      }

      // Start with suppliers from HTML
      let suppliers: string[] = detail.htmlSuppliers;
      let rawText = detail.rawText;

      // If a PDF is linked, try that too — usually has more structured data
      const pdfUrl = detail.pdfUrl ?? tender.pdfUrl;
      if (pdfUrl) {
        try {
          const pdf = await extractPdfData(pdfUrl);
          if (pdf.unsuccessfulSuppliers.length > 0) {
            suppliers = pdf.unsuccessfulSuppliers;
            rawText = pdf.text.slice(0, 100_000);
          }
        } catch {
          // PDF failed — HTML results are still used
        }
      }

      // Save results
      await db.update(tendersTable).set({
        pdfStatus: "processed",
        buyerName: detail.buyerName ?? tender.buyerName,
        description: detail.description ?? tender.description,
        awardedValue: detail.awardedValue?.toString() ?? tender.awardedValue,
        pdfUrl: pdfUrl ?? tender.pdfUrl,
        rawPdfText: rawText,
        unsuccessfulSuppliers: suppliers,
      }).where(eq(tendersTable.id, tender.id));

      analysed++;
      results.push({ title: tender.title, buyerName: detail.buyerName, unsuccessfulSuppliers: suppliers });

      logger.info({ tenderId: tender.id, suppliers: suppliers.length }, "Tender analysed");
    } catch (err) {
      logger.error({ err, tenderId: tender.id }, "Failed to analyse tender");
      await db.update(tendersTable).set({ pdfStatus: "failed" }).where(eq(tendersTable.id, tender.id));
      failed++;
    }
  }

  logger.info({ newTenders, analysed, failed }, "Daily job complete");
  return { newTenders, analysed, failed, results };
}
