/* session.js is a configuration file for the express-session middleware. It configures the session middleware using the express-session package and the connect-redis package to store the session data in a Redis store. It also sets the session secret, cookie settings, and other options for the session middleware. */

import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import dotenv from "dotenv-flow";

dotenv.config();

const redisClient = createClient({
    url: process.env.REDIS_URL,
    legacyMode: true,
});

redisClient.connect().catch(console.error);

const sessionMiddleware = session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
});

export default sessionMiddleware;
