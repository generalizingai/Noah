import { Router, type IRouter } from "express";
import healthRouter from "./health";
import omiProxyRouter from "./omi-proxy";
import noahBackendProxy from "./noah-backend-proxy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(omiProxyRouter);
router.use("/noah-backend", noahBackendProxy);

export default router;
