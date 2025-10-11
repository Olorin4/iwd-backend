import morgan from "morgan";
import fs from "fs";
import path from "path";
import winston from "winston";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: "logs/error.log", level: "error" }),
        new winston.transports.File({ filename: "logs/combined.log" }),
    ],
});

function configureLogging(app) {
    const accessLogStream = fs.createWriteStream(
        path.join(__dirname, "../logs/access.log"),
        { flags: "a" }
    );

    app.use(
        morgan("combined", {
            stream: accessLogStream,
            skip: (req, res) => res.statusCode < 400, // Log only errors and warnings
        })
    );

    // Middleware to attach Winston logger to requests
    app.use((req, next) => {req.logger = logger; next();});

    // Middleware to log security events
    app.use((req, next) => {
        req.logger.info({
            message: "Security Event",
            method: req.method,
            route: req.originalUrl,
            ip: req.ip,
        });
        next();
    });
}

export { logger, configureLogging };