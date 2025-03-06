/* session.js is a configuration file for the express-session middleware. It configures the session middleware using the express-session package and the connect-redis package to store the session data in a Redis store. It also sets the session secret, cookie settings, and other options for the session middleware. */

import session from "express-session";
import dotenv from "dotenv-flow";
import { createClient } from "redis";
import { RedisStore } from "connect-redis";

dotenv.config();

// Create Redis Client
const redisClient = createClient({
    url: process.env.REDIS_URL,
    legacyMode: true, // Required for compatibility
});
redisClient.connect().catch(console.error);

// Correct way to initialize RedisStore for connect-redis v4+
const redisStore = new RedisStore({
    client: redisClient,
    disableTouch: true, // Optional: Reduces unnecessary session refreshing
});

if (!process.env.SESSION_SECRET) {
    console.error("⚠️ SESSION_SECRET is not set! Add it to your .env file.");
    process.exit(1); // Stop the server if SESSION_SECRET is missing
}

// This ensures sessions persist and are stored in Redis
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: redisStore,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
});

export default sessionMiddleware;
