import { Router, type IRouter } from "express";
import { eq, desc, count, avg, max, sql } from "drizzle-orm";
import { db, tendersTable } from "@workspace/db";
import {
  SearchTendersBody,
  ListTendersQueryParams,
  GetTenderParams,
  ProcessTenderPdfParams,
} from "@workspace/api-zod";
import { searchAwardedTenders, fetchTenderDetail } from "../lib/tender-scraper";
import { extractPdfData } from "../lib/pdf-extractor";
import { runDailyJob } from "../lib/daily-job";
import { logger } from "../lib/logger";
import { v4 as uuidv4 } from "uuid";

const router: IRouter = Router();

// DELETE /tenders — wipe all tenders from the database
router.delete("/tenders", async (req, res): Promise<void> => {
  try {
    await db.delete(tendersTable);
    req.log.info("All tenders deleted");
    res.json({ message: "Database cleared." });
  } catch (err) {
    req.log.error({ err }, "Failed to clear database");
    res.status(500).json({ error: "Failed to clear database" });
  }
});

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

// POST /tenders/search — runs the standard awarded-contract search
router.post("/tenders/search", async (req, res): Promise<void> => {
  const parsed = SearchTendersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { keyword = "Framework" } = parsed.data;
  const jobId = uuidv4();
  req.log.info({ jobId, keyword }, "Starting tender search");

  runDailyJob(3)
    .then((result) => logger.info({ jobId, ...result }, "Search job complete"))
    .catch((err) => logger.error({ err, jobId }, "Search job failed"));

  res.json({ jobId, message: `Search started for "${keyword}".` });
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

// POST /tenders/:id/process — re-analyse a single tender
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

  await db.update(tendersTable).set({ pdfStatus: "downloading" }).where(eq(tendersTable.id, tender.id));

  // Run async
  (async () => {
    try {
      const detail = await fetchTenderDetail(tender.noticeUrl);
      let suppliers: string[] = detail.htmlSuppliers;
      let rawText = detail.rawText;

      const pdfUrl = detail.pdfUrl ?? tender.pdfUrl;
      if (pdfUrl) {
        try {
          const pdf = await extractPdfData(pdfUrl);
          if (pdf.unsuccessfulSuppliers.length > 0) {
            suppliers = pdf.unsuccessfulSuppliers;
            rawText = pdf.text.slice(0, 100_000);
          }
        } catch { /* use HTML results */ }
      }

      await db.update(tendersTable).set({
        pdfStatus: "processed",
        buyerName: detail.buyerName ?? tender.buyerName,
        description: detail.description ?? tender.description,
        awardedValue: detail.awardedValue?.toString() ?? tender.awardedValue,
        pdfUrl: pdfUrl ?? tender.pdfUrl,
        rawPdfText: rawText,
        unsuccessfulSuppliers: suppliers,
      }).where(eq(tendersTable.id, tender.id));

      logger.info({ tenderId: tender.id, suppliers: suppliers.length }, "Re-analysis complete");
    } catch (err) {
      logger.error({ err, tenderId: tender.id }, "Re-analysis failed");
      await db.update(tendersTable).set({ pdfStatus: "failed" }).where(eq(tendersTable.id, tender.id));
    }
  })();

  const [updated] = await db.select().from(tendersTable).where(eq(tendersTable.id, tender.id)).limit(1);
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
