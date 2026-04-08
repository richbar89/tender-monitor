import cron from "node-cron";
import app from "./app";
import { logger } from "./lib/logger";
import { runDailyJob } from "./lib/daily-job";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Schedule daily job at 06:00 UTC every day
  cron.schedule("0 6 * * *", () => {
    logger.info("Triggering scheduled daily tender job");
    runDailyJob().catch((err) => {
      logger.error({ err }, "Scheduled daily job failed");
    });
  });

  logger.info("Daily tender job scheduled for 06:00 UTC");
});
