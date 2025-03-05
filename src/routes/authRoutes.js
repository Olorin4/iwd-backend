// authRouter.js

import express from "express";
import passport from "../config/passport.js";
import {
    registerUser,
    loginJWT,
    loginSession,
    logoutSession,
} from "../controllers/authController.js";

const authRouter = express.Router();

authRouter.post("/register", registerUser);

// JWT Authentication (for APIs & mobile users)
authRouter.post("/login/jwt", loginJWT);

// Protected route requiring a valid JWT token
authRouter.get(
    "/profile",
    passport.authenticate("jwt", { session: false }),
    (req, res) => {
        console.log("Authenticated user:", req.user);
        res.json({ user: req.user });
    }
);

// Session-Based Authentication (for desktop users)
authRouter.post("/login/session", passport.authenticate("local"), loginSession);
authRouter.post("/logout", logoutSession);

export default authRouter;
