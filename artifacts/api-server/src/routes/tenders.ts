import { Router, type IRouter } from "express";
import { eq, desc, count, avg, max, sql } from "drizzle-orm";
import { db, tendersTable } from "@workspace/db";
import {
  SearchTendersBody,
  ListTendersQueryParams,
  GetTenderParams,
  ProcessTenderPdfParams,
} from "@workspace/api-zod";
import { searchTenders, fetchTenderDetail } from "../lib/tender-scraper";
import { extractPdfData } from "../lib/pdf-extractor";
import { runDailyJob } from "../lib/daily-job";
import { logger } from "../lib/logger";
import { v4 as uuidv4 } from "uuid";

const router: IRouter = Router();

// POST /tenders/run-now — manually trigger the daily pipeline
router.post("/tenders/run-now", async (req, res): Promise<void> => {
  req.log.info("Manual daily job triggered via API");
  // Run async so we don't hold the connection open for potentially minutes
  runDailyJob()
    .then((result) => {
      logger.info(result, "Manual daily job completed");
    })
    .catch((err) => {
      logger.error({ err }, "Manual daily job failed");
    });

  res.json({ message: "Daily job started. Check server logs for progress." });
});

// POST /tenders/search
router.post("/tenders/search", async (req, res): Promise<void> => {
  const parsed = SearchTendersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    keyword,
    minValue = 5_000_000,
    stages = ["award", "contract", "awarded", "contracted"],
  } = parsed.data;

  const jobId = uuidv4();
  req.log.info({ jobId, keyword, minValue, stages }, "Starting tender search");

  // Run async - don't block the response
  (async () => {
    try {
      const scraped = await searchTenders(keyword, minValue ?? 5_000_000, stages);
      req.log.info({ jobId, count: scraped.length }, "Scraped tenders");

      for (const tender of scraped) {
        try {
          // Upsert by noticeId
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
          }
        } catch (err) {
          logger.warn({ err, noticeId: tender.noticeId }, "Failed to upsert tender");
        }
      }
    } catch (err) {
      logger.error({ err, jobId }, "Tender search job failed");
    }
  })();

  // Start scrape to get count estimate quickly too
  let tendersFound = 0;
  try {
    const quick = await searchTenders(keyword, minValue ?? 5_000_000, stages);
    tendersFound = quick.length;
  } catch {
    // non-blocking
  }

  res.json({
    jobId,
    message: `Search started for "${keyword}". Results are being saved.`,
    tendersFound,
  });
});

// GET /tenders/stats/summary - must be before /tenders/:id
router.get("/tenders/stats/summary", async (req, res): Promise<void> => {
  try {
    const [statsRow] = await db
      .select({
        total: count(),
        avgValue: avg(tendersTable.awardedValue),
        maxValue: max(tendersTable.awardedValue),
      })
      .from(tendersTable);

    const [processedRow] = await db
      .select({ cnt: count() })
      .from(tendersTable)
      .where(eq(tendersTable.pdfStatus, "processed"));

    const [failedRow] = await db
      .select({ cnt: count() })
      .from(tendersTable)
      .where(eq(tendersTable.pdfStatus, "failed"));

    const withSuppliersResult = await db
      .select({ cnt: count() })
      .from(tendersTable)
      .where(sql`jsonb_array_length(${tendersTable.unsuccessfulSuppliers}) > 0`);

    res.json({
      total: statsRow?.total ?? 0,
      withUnsuccessfulSuppliers: withSuppliersResult[0]?.cnt ?? 0,
      totalPdfProcessed: processedRow?.cnt ?? 0,
      totalPdfFailed: failedRow?.cnt ?? 0,
      averageValue: statsRow?.avgValue ? parseFloat(String(statsRow.avgValue)) : null,
      highestValue: statsRow?.maxValue ? parseFloat(String(statsRow.maxValue)) : null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get tender stats");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// GET /tenders
router.get("/tenders", async (req, res): Promise<void> => {
  const parsed = ListTendersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 20;
  const offset = (page - 1) * limit;
  const statusFilter = parsed.data.status;

  try {
    const query = db
      .select()
      .from(tendersTable)
      .orderBy(desc(tendersTable.createdAt))
      .limit(limit)
      .offset(offset);

    const countQuery = db.select({ cnt: count() }).from(tendersTable);

    let tenders;
    let totalResult;

    if (statusFilter) {
      tenders = await db
        .select()
        .from(tendersTable)
        .where(eq(tendersTable.pdfStatus, statusFilter))
        .orderBy(desc(tendersTable.createdAt))
        .limit(limit)
        .offset(offset);
      totalResult = await db
        .select({ cnt: count() })
        .from(tendersTable)
        .where(eq(tendersTable.pdfStatus, statusFilter));
    } else {
      tenders = await query;
      totalResult = await countQuery;
    }

    const total = totalResult[0]?.cnt ?? 0;

    res.json({
      tenders: tenders.map(formatTender),
      total,
      page,
      limit,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to list tenders");
    res.status(500).json({ error: "Failed to fetch tenders" });
  }
});

// GET /tenders/:id
router.get("/tenders/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetTenderParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const [tender] = await db
    .select()
    .from(tendersTable)
    .where(eq(tendersTable.id, params.data.id))
    .limit(1);

  if (!tender) {
    res.status(404).json({ error: "Tender not found" });
    return;
  }

  res.json(formatTenderDetail(tender));
});

// POST /tenders/:id/process
router.post("/tenders/:id/process", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ProcessTenderPdfParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const [tender] = await db
    .select()
    .from(tendersTable)
    .where(eq(tendersTable.id, params.data.id))
    .limit(1);

  if (!tender) {
    res.status(404).json({ error: "Tender not found" });
    return;
  }

  // If no PDF URL, try fetching the detail page first
  if (!tender.pdfUrl) {
    req.log.info({ tenderId: tender.id }, "No PDF URL, fetching tender detail page");
    try {
      const detail = await fetchTenderDetail(tender.noticeUrl);
      if (detail.pdfUrl) {
        await db
          .update(tendersTable)
          .set({ pdfUrl: detail.pdfUrl })
          .where(eq(tendersTable.id, tender.id));
        tender.pdfUrl = detail.pdfUrl;
      }
      // Update other detail fields too
      if (detail.description || detail.buyerName || detail.awardedValue) {
        await db
          .update(tendersTable)
          .set({
            description: detail.description ?? tender.description,
            buyerName: detail.buyerName ?? tender.buyerName,
            awardedValue: detail.awardedValue?.toString() ?? tender.awardedValue,
          })
          .where(eq(tendersTable.id, tender.id));
      }
    } catch (err) {
      req.log.warn({ err }, "Failed to fetch tender detail page");
    }
  }

  if (!tender.pdfUrl) {
    // Mark as failed if still no PDF URL
    await db
      .update(tendersTable)
      .set({ pdfStatus: "failed" })
      .where(eq(tendersTable.id, tender.id));

    const [updated] = await db
      .select()
      .from(tendersTable)
      .where(eq(tendersTable.id, tender.id))
      .limit(1);

    res.json(formatTenderDetail(updated));
    return;
  }

  // Set status to downloading
  await db
    .update(tendersTable)
    .set({ pdfStatus: "downloading" })
    .where(eq(tendersTable.id, tender.id));

  // Process async
  (async () => {
    try {
      const result = await extractPdfData(tender.pdfUrl!);

      await db
        .update(tendersTable)
        .set({
          pdfStatus: "processed",
          rawPdfText: result.text.slice(0, 100_000), // Store first 100k chars
          unsuccessfulSuppliers: result.unsuccessfulSuppliers,
        })
        .where(eq(tendersTable.id, tender.id));

      logger.info(
        { tenderId: tender.id, suppliers: result.unsuccessfulSuppliers.length },
        "PDF processed successfully",
      );
    } catch (err) {
      logger.error({ err, tenderId: tender.id }, "Failed to process PDF");
      await db
        .update(tendersTable)
        .set({ pdfStatus: "failed" })
        .where(eq(tendersTable.id, tender.id));
    }
  })();

  // Return with downloading status
  const [updated] = await db
    .select()
    .from(tendersTable)
    .where(eq(tendersTable.id, tender.id))
    .limit(1);

  res.json(formatTenderDetail(updated));
});

function formatTender(tender: typeof tendersTable.$inferSelect) {
  return {
    id: tender.id,
    noticeId: tender.noticeId,
    title: tender.title,
    description: tender.description,
    buyerName: tender.buyerName,
    awardedValue: tender.awardedValue ? parseFloat(String(tender.awardedValue)) : null,
    currency: tender.currency,
    procurementStage: tender.procurementStage,
    publishedDate: tender.publishedDate,
    noticeUrl: tender.noticeUrl,
    pdfStatus: tender.pdfStatus,
    unsuccessfulSuppliers: (tender.unsuccessfulSuppliers as string[]) ?? [],
    createdAt: tender.createdAt.toISOString(),
    updatedAt: tender.updatedAt.toISOString(),
  };
}

function formatTenderDetail(tender: typeof tendersTable.$inferSelect) {
  return {
    ...formatTender(tender),
    pdfUrl: tender.pdfUrl,
    rawPdfText: tender.rawPdfText,
  };
}

export default router;
