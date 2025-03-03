// passport-jwt.js

import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";
import passport from "passport";
import dotenv from "dotenv-flow";
import prisma from "../prismaClient.js";

dotenv.config();

const opts = {
    jwtFromRequest: (req) => {
        if (req && req.cookies) return req.cookies.token; // Support JWT in Cookies
        return ExtractJwt.fromAuthHeaderAsBearerToken()(req); // Default
    },
    secretOrKey: process.env.JWT_SECRET,
};

passport.use(
    new JwtStrategy(opts, async (jwt_payload, done) => {
        try {
            const user = await prisma.user.findUnique({
                where: { id: jwt_payload.id },
            });

            if (user) return done(null, user);
            return done(null, false);
        } catch (err) {
            return done(err, false);
        }
    })
);

export default passport;
