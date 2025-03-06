import passport from "passport";
import bcrypt from "bcryptjs";
import { prisma } from "./prismaClient.js";
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";
import { Strategy as LocalStrategy } from "passport-local";
import { publicKey } from "../config/generateKeys.js";

// JWT Strategy (For API & Mobile Users)
const jwtOptions = {
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: publicKey,
    algorithms: ["RS256"],
};

passport.use(
    new JwtStrategy(jwtOptions, async (jwt_payload, done) => {
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
