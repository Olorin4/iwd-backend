//authController.js

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv-flow";
import prisma from "../prismaClient.js";

dotenv.config();

export const register = async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ message: "All fields are required" });
        }

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser)
            return res.status(400).json({ message: "User already exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await prisma.user.create({
            data: { name, email, password: hashedPassword },
        });

        res.status(201).json({
            message: "User registered successfully",
            userId: newUser.id,
        });
    } catch (error) {
        console.error("Register Error:", error);
        res.status(500).json({ error: "Error registering user" });
    }
};

export const loginJWT = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await prisma.user.findUnique({ where: { email } });

        if (!user)
            return res.status(400).json({ message: "Invalid credentials" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch)
            return res.status(400).json({ message: "Invalid credentials" });

        const token = jwt.sign(
            { id: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: "1d" }
        );

        res.status(200).json({ token });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
};

export const loginSession = (req, res) => res.json({ user: req.user });

export const logoutSession = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res
            .status(401)
            .json({ message: "Unauthorized - Not logged in" });
    }
    req.logout((err) => {
        if (err) return next(err);
        res.json({ message: "Logged out successfully" });
    });
};
