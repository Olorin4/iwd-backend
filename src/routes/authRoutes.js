// authRouter.js

import express from "express";
import passport from "../config/passport.js";
import {
    registerUser,
    loginJWT,
    loginSession,
    logoutSession,
    getProfile,
    checkAuthenticated,
} from "../controllers/authController.js";

const authRouter = express.Router();

authRouter.post("/register", registerUser);

// JWT Authentication (for APIs & mobile users)
authRouter.post("/login/jwt", loginJWT);
// Protected route requiring a valid JWT token
authRouter.get(
    "/profile",
    passport.authenticate("jwt", { session: false }),
    getProfile
);

// Session-Based Authentication (for desktop users)
authRouter.post("/login/session", passport.authenticate("local"), loginSession);
authRouter.post("/logout", logoutSession);
// Protected route requiring a valid session
authRouter.get("/profile/session", checkAuthenticated, getProfile);

export default authRouter;
