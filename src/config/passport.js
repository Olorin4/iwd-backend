import passport from "passport";
import dotenv from "dotenv-flow";
import bcrypt from "bcryptjs";
import { prisma } from "./prismaClient.js";
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";
import { Strategy as LocalStrategy } from "passport-local";

dotenv.config();

// JWT Strategy (For API & Mobile Users)
const jwtOpts = {
    jwtFromRequest: (req) => {
        if (req && req.cookies) return req.cookies.token; // Supports token in cookies
        if (req && req.query && req.query.token) return req.query.token; // Supports token in WebSocket query params
        return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    },
    secretOrKey: process.env.JWT_SECRET,
};

passport.use(
    new JwtStrategy(jwtOpts, async (jwt_payload, done) => {
        try {
            const user = await prisma.user.findUnique({
                where: { id: jwt_payload.id },
            });
            return user ? done(null, user) : done(null, false);
        } catch (err) {
            return done(err, false);
        }
    })
);

// Local Strategy (For Desktop Users)
passport.use(
    new LocalStrategy(
        { usernameField: "email", passReqToCallback: true },
        async (req, email, password, done) => {
            try {
                const user = await prisma.user.findUnique({ where: { email } });

                if (!user)
                    return done(null, false, { message: "User not found" });

                const isMatch = await bcrypt.compare(password, user.password);
                if (!isMatch)
                    return done(null, false, { message: "Incorrect password" });

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }
    )
);

// Serialize & Deserialize Users
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
    try {
        const user = await prisma.user.findUnique({ where: { id } });
        done(null, user);
    } catch (err) {
        done(err);
    }
});

export default passport;
