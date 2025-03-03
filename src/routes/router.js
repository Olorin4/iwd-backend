// routes/router.js

import express from "express";
import dotenv from "dotenv-flow";
import authRouter from "./routes/authRouter.js";
import sessionMiddleware from "../config/session.js";
import passportLocal from "../config/passport-local.js";
import { submitForm, contactForm } from "../controllers/handler.js";
import {
    getAllSignUpForms,
    getAllContactSubmissions,
} from "../models/dataModel.js";

dotenv.config();

const router = express.Router();

// Apply session middleware (Only for routes in router.js)
router.use(passportLocal.initialize());
router.use(passportLocal.session());
router.use(sessionMiddleware);

// Use authentication routes
router.use("/auth", authRouter);

// Future feature-based routes
// router.use('/users', userRouter);
// router.use('/jobs', jobRouter);
// Routes for Sign-Up Forms
router.route("/sign-up-forms").post(submitForm).get(getAllSignUpForms);

// Routes for Contact Submissions
router
    .route("/contact-submissions")
    .post(contactForm)
    .get(getAllContactSubmissions);

// Example of other grouped routes (optional)
router.get("/health-check", (req, res) => res.json({ status: "OK" }));

export default router;
