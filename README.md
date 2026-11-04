# Backend for iron-wing-dispatching.com

## **Summary**

Receives forms submitted by potential clients in iron-wing-dispatching.com. Sanitizes them and sends emails to client and admin. In future, an AI chatbot will be added to the frontend that will answer FAQ based on busines rules and guide clients to onboarding...

## **Endpoints**

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/sign-up-forms` | public | Sign-up form submission |
| POST | `/contact-forms` | public | Contact form submission |
| POST | `/newsletter` | public, 10 per IP per hour | Newsletter signup (stores the email, sends a welcome email) |
| GET | `/sign-up-forms` | admin token | List recent sign-up leads |
| GET | `/contact-forms` | admin token | List recent contact submissions |
| GET | `/health-check` | public | Health check |

### Admin token

The lead listing endpoints require `Authorization: Bearer <ADMIN_API_TOKEN>`.
If `ADMIN_API_TOKEN` is not set, those endpoints reject every request.
In production the value comes from the `ADMIN_API_TOKEN` GitHub secret, which the
deploy workflow writes into `.env`. Generate one with `openssl rand -hex 32`.

