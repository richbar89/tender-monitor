import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tendersRouter from "./tenders";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tendersRouter);

export default router;
