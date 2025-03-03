// authRouter.js

import express from "express";
import passportJWT from "../config/passport-jwt.js";
import passportLocal from "../config/passport-local.js";
import {
    register,
    loginJWT,
    loginSession,
    logoutSession,
} from "../controllers/authController.js";

const authRouter = express.Router();

// JWT Authentication (for API & Mobile)
authRouter.post("/register", register);
authRouter.post("/login/jwt", loginJWT);
authRouter.get(
    "/profile",
    passportJWT.authenticate("jwt", { session: false }),
    (req, res) => {
        res.json({ user: req.user });
    }
);

// Session-Based Authentication (for Electron)
authRouter.post(
    "/login/session",
    passportLocal.authenticate("local"),
    loginSession
);
authRouter.post("/logout", logoutSession);

export default authRouter;
