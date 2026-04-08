import { pgTable, text, serial, timestamp, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tendersTable = pgTable("tenders", {
  id: serial("id").primaryKey(),
  noticeId: text("notice_id").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  buyerName: text("buyer_name"),
  awardedValue: numeric("awarded_value", { precision: 18, scale: 2 }),
  currency: text("currency").default("GBP"),
  procurementStage: text("procurement_stage").notNull(),
  publishedDate: text("published_date"),
  noticeUrl: text("notice_url").notNull(),
  pdfUrl: text("pdf_url"),
  pdfStatus: text("pdf_status").notNull().default("none"),
  rawPdfText: text("raw_pdf_text"),
  unsuccessfulSuppliers: jsonb("unsuccessful_suppliers").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTenderSchema = createInsertSchema(tendersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTender = z.infer<typeof insertTenderSchema>;
export type Tender = typeof tendersTable.$inferSelect;
