//authController.js

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "../config/prismaClient.js";

export const registerUser = async (req, res) => {
    try {
        const { email, password, role } = req.body;
        if (!email || !password || !role) {
            console.error("Validation Error: Missing fields");
            return res.status(400).json({ message: "All fields are required" });
        }
        console.log(`Attempting to create user: ${email}`);
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            console.error("User already exists:", email);
            return res.status(400).json({ message: "User already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                role,
            },
        });

        // **Create profile based on role**
        if (role === "driver") {
            await prisma.driver.create({
                data: { user_id: newUser.id, company_id: companyId },
            });
        } else if (role === "dispatcher") {
            await prisma.dispatcher.create({
                data: { user_id: newUser.id, company_id: companyId },
            });
        }

        console.log("User created successfully:", newUser);
        res.status(201).json({
            message: "User created successfully",
            userId: newUser.id,
        });
    } catch (error) {
        console.error("Register Error:", error);
        res.status(500).json({ error: "Error creating user" });
    }
};

// Login for mobile users
export const loginJWT = async (req, res) => {
    try {
        const { email, password } = req.body;
        console.log(`JWT Login Attempt: ${email}`);

        const user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
            console.error("Invalid credentials: No user found");
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.error("Invalid credentials: Wrong password");
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: "1d" }
        );

        console.log("JWT Token Issued:", token);
        res.status(200).json({ token });
    } catch (error) {
        console.error("JWT Login Error:", error);
        res.status(500).json({ error: "Server error" });
    }
};

// Session-based Login for desktop users
export const loginSession = (req, res) => {
    console.log("Session Login Attempt:", req.body.email);
    if (!req.user) {
        console.error("Session Login Failed: No user found");
        return res.status(401).json({ message: "Invalid credentials" });
    }

    console.log("Session Login Success:", req.user);
    res.json({ user: req.user });
};

export const logoutSession = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res
            .status(401)
            .json({ message: "Unauthorized - Not logged in" });
    }
    req.logout((err) => {
        if (err) return res.status(500).json({ error: "Logout failed" });
        req.session.destroy((err) => {
            if (err)
                return res
                    .status(500)
                    .json({ error: "Failed to destroy session" });
            res.json({ message: "Logged out successfully" });
        });
    });
};
