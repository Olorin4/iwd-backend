import { body, validationResult } from "express-validator";
import { prisma } from "./prismaClient.js";
import { emailClient } from "./emailService.js";
import { attributionOf, recordAfterResponse } from "./formConversions.js";

const validateNewsletter = [
    body("email")
        .trim()
        .isEmail()
        .withMessage("Invalid email address.")
        .isLength({ max: 254 })
        .withMessage("Invalid email address."),
];

const sanitizeNewsletter = [
    // Keep dots in Gmail-style addresses so we store what the person typed.
    body("email").normalizeEmail({ gmail_remove_dots: false }),
];

async function newsletterSignup(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { email } = req.body;
    const { identityEmail, attribution } = attributionOf(res);
    let isNewSubscriber = true;
    let subscriber = null;

    try {
        subscriber = await prisma.newsletterSubscriber.create({
            data: {
                email,
                source: "website",
                outreach_ref: attribution.outreachRef,
                posthog_distinct_id: attribution.posthogDistinctId,
            },
        });
    } catch (error) {
        if (error?.code === "P2002") {
            // Already subscribed. Answer exactly as for a new subscriber so the
            // endpoint cannot be used to discover who is on the list.
            isNewSubscriber = false;
        } else {
            console.error("Database Error (newsletterSignup):", error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }

    res.status(200).json({ message: "Subscribed successfully!" });

    // A repeat subscription is not a new conversion, and the existing row
    // (with whatever attribution it first had) is left as it is.
    if (!isNewSubscriber) return;

    recordAfterResponse({
        type: "newsletter",
        leadId: subscriber?.id ?? null,
        identityEmail,
        attribution,
        properties: {},
    });

    try {
        await emailClient(
            email,
            "Welcome to Iron Wing Dispatching Trucking Tips",
            `Hello,\n\nThank you for subscribing to trucking tips and updates from Iron Wing Dispatching. To unsubscribe at any time, reply to this email with the word "unsubscribe".\n\nAll the best,\nIron Wing Dispatching Team`
        );
    } catch (emailError) {
        console.error("Email Error (newsletterSignup):", emailError);
    }
}

export { validateNewsletter, sanitizeNewsletter, newsletterSignup };
