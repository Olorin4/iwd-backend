/* passport-local.js is a configuration file for the passport-local strategy. It uses the LocalStrategy from the passport-local package to authenticate users using their email and password. It also uses bcrypt to compare the password provided by the user with the hashed password stored in the database. The serializeUser and deserializeUser functions are used to store and retrieve the user object in the session. */

import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcryptjs";
import prisma from "../prismaClient.js";

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

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await prisma.user.findUnique({ where: { id } });
        done(null, user);
    } catch (err) {
        done(err);
    }
});

export default passport;
