# Contact API

A serverless contact-form backend for a personal portfolio site, built on AWS. It accepts a name, email, and message from a website form, verifies the submission is human, and delivers it as a formatted email — with no server to manage and near-zero running cost.

## The Problem It Solves

Personal and portfolio websites need a way for visitors to get in touch, but a plain `mailto:` link is easy to ignore, offers no spam protection, and gives no record of who reached out or how. Standing up a traditional backend (a server, a database, an always-on process) just to relay a few messages a month is disproportionate — it adds hosting cost, security surface, and maintenance for a feature that is used occasionally and briefly.

This project solves that by giving the site a real, secure submission endpoint that:
- Confirms the sender is a human, not a bot, before anything is processed.
- Delivers a clean, readable notification email straight to an inbox — no dashboard or database to check.
- Captures useful context automatically (when the message came in, roughly how long it is, where it was sent from) without asking the visitor for it or trusting anything they claim.
- Costs effectively nothing to run and requires no server to patch, monitor, or scale.

## My Role and Process

I designed and built the entire backend end-to-end, from architecture through deployment configuration:

1. **Defined the contract** — a single `POST /contact` endpoint accepting `name`, `email`, `message`, and a bot-verification token, matching what the website's contact form needed to send.
2. **Chose a fully serverless architecture** to avoid any always-on infrastructure: API Gateway to receive the request, a single Lambda function to process it, and SES to deliver the email — nothing to provision, patch, or pay for while idle.
3. **Hardened the endpoint against abuse** by verifying the CAPTCHA token server-side, re-validating every field before use, and computing sensitive metadata (IP, user agent, timestamp) from the request itself rather than trusting client-supplied values.
4. **Built the email as a real deliverable**, not just a raw dump of form fields — a styled HTML template with a plain-text fallback for deliverability, with all user-supplied content HTML-escaped to prevent injection into the rendered email.
5. **Modeled and deployed the infrastructure as code** using AWS CDK, so the entire stack (API, Lambda, permissions, email identity, rate limiting) is version-controlled and reproducible with a single deploy command rather than assembled by hand in the AWS console.
6. **Tuned for a low-traffic, cost-sensitive use case** — sizing throttling limits and Lambda resources for a personal-site volume, and deliberately leaving out infrastructure (like AWS WAF) whose cost isn't justified at that scale.
7. **Documented the operational setup** (domain/DKIM verification, CAPTCHA configuration, deployment steps) so the project can be redeployed or handed off without re-deriving the setup from the code.

## Technologies and Tools Used

- **TypeScript end to end** — one language for both the infrastructure definition and the Lambda handler, with typed API Gateway events and a typed request payload.
- **Serverless request handling with AWS Lambda (Node.js)** — a single on-demand function validates the submission, verifies the CAPTCHA, builds the email, and sends it; nothing runs (or costs money) between requests.
- **Public endpoint, CORS, and rate limiting with Amazon API Gateway (HTTP API)** — exposes `POST /contact`, restricts browser access to an allowlist of front-end origins, and applies stage-level throttling. HTTP API was chosen over REST API because it is cheaper and covers everything this endpoint needs.
- **Authenticated email delivery with Amazon SES** — sends the notification from a custom-domain address with DKIM signing, an HTML body plus a plain-text fallback, and the sender's address set as reply-to.
- **Infrastructure as code with AWS CDK** — the whole stack (Lambda, API, SES identity, throttling, log retention) is defined in code and deployed with one command. This includes an IAM policy that limits the function to SES send actions, and deploy outputs for the endpoint URL and the DKIM records that have to be added by hand at the DNS provider.
- **CAPTCHA validation via Cloudflare Turnstile** — the token is checked server-side against Cloudflare's verification API before anything is processed. Each allowed origin has its own secret key, so more than one site can share the same backend.
- **Hand-built HTML email template** — an inline-styled template that renders well across email clients, shows optional sections only when the form sends those fields, and HTML-escapes all user input before inserting it.

## Results / Impact

- Delivers a working, production-ready contact channel for the portfolio site with **no server to maintain and no idle cost** — infrastructure spend for realistic personal-site traffic (hundreds of messages/month) runs an estimated **$0–$0.05/month**, staying well within AWS free-tier limits.
- **Blocks automated spam submissions** at the API layer via server-side CAPTCHA verification, before any message reaches an inbox.
- **Rate-limits the public endpoint** (5 requests/second sustained, burst of 10) to contain abuse or misconfiguration without needing paid protections like AWS WAF.
- Removes the need for a database, admin dashboard, or third-party form service — every submission simply arrives as a well-formatted email, with the sender's reply-to address already set so replying is a single click.
- The entire stack is reproducible from source in a single `cdk deploy`, meaning the whole backend can be torn down, recreated, or migrated to a new AWS account/region with no manual reconfiguration.

## Images, Screenshots, or Live Demos

No screenshots are currently included in this repository. The most useful visual reference would be a rendered sample of the notification email, generated from `lambda/email-template.html` — a dark-themed card showing the sender's name, initials, email, message, and submission metadata. A screenshot of that rendered template (e.g., as viewed in an email client) could be added here, along with a short GIF of the live contact form on the portfolio site submitting successfully.

## Repository / Live Site

- **Source code:** this repository — the CDK stack lives in [`lib/`](lib/), the Lambda handler and email template in [`lambda/`](lambda/).
- **Live site:** the API backs the contact form at [mario-gutierrez.com](https://mario-gutierrez.com).

For full setup and deployment instructions (SES/domain verification, Turnstile configuration, environment variables, and deploy commands), see [`DEPLOY.md`](DEPLOY.md).
