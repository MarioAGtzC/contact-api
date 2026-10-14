# Contact API

A serverless backend for website contact forms, built on AWS with TypeScript. It accepts a form submission, verifies the sender is human, and delivers the message to an inbox as a formatted email. One deployment serves the contact forms of two of my sites.

## The Problem It Solves

A personal website needs a reliable way for visitors to get in touch without exposing a personal email address or letting bots flood the inbox. A traditional server just to relay a handful of messages is more to run, secure, and maintain than the feature is worth.

This project gives each site a single, secure endpoint that:

- Filters out bots before a message is ever sent.
- Delivers every submission as a readable email; replying to it goes straight to the sender.
- Records useful context (time, source page, device, IP) automatically, without trusting anything the browser claims.
- Runs only when a message arrives; there is no server to patch or keep online.

## My Role and Process

Solo project: I designed, built, and deployed it end to end.

1. **Defined the contract**: one `POST /contact` endpoint taking `name`, `email`, `message`, and a CAPTCHA token, plus optional `phone` and `subject` fields so a second site could send more data without breaking the first.
2. **Chose a fully serverless design**: API Gateway → Lambda → SES, with no database and no always-on compute.
3. **Hardened the endpoint**:
   - Validates every field server-side (required fields, email format, length caps of 100 / 254 / 5,000 characters for name / email / message).
   - Verifies the CAPTCHA token and checks that it was solved on the same site making the request.
   - Rejects any origin that has no CAPTCHA secret configured.
   - HTML-escapes all user input before it goes into the email.
4. **Made multi-site support a configuration change**: each allowed origin has its own CAPTCHA secret, stored as a parameter named after the site, and a short label, so the email shows which site a message came from.
5. **Defined all infrastructure as code** with AWS CDK. The CAPTCHA secrets and the destination address live in AWS Systems Manager Parameter Store, never in the repo or the deploy command. The deploy stops with an error if the destination address is missing.
6. **Made deliberate cost and scope trade-offs**: an HTTP API instead of a REST API, and API-wide throttling instead of AWS WAF per-IP rules.

Setup and deployment steps are in [DEPLOY.md](DEPLOY.md).

## Technologies and Tools

**Language and runtime**
- **TypeScript** for both the infrastructure definition and the request handler, with typed API Gateway events and a typed payload.
- **AWS Lambda (Node.js 24)** runs the handler: 256 MB memory, a 10-second timeout, and logs kept for one month.

**API and traffic control**
- **Amazon API Gateway (HTTP API)** exposes the public endpoint, allows CORS only for a list of approved front-end origins, and throttles the whole API to 5 requests/second, with bursts of up to 10.

**Email delivery**
- **Amazon SES (AWS SDK v3)** sends from a custom-domain address with DKIM signing. Each email has an HTML body, a plain-text fallback, and the sender set as reply-to.
- **Custom HTML email template** with inline styles, placeholder substitution, and sections that appear only when optional fields (phone, subject) are sent.

**Bot protection**
- **Cloudflare Turnstile** CAPTCHA, checked server-side against Cloudflare's verification API, with a separate secret for each site.

**Infrastructure as code and security**
- **AWS CDK** defines the Lambda, the HTTP API and its route, CORS, throttling, the SES domain identity, and log retention. Deploying prints the endpoint URL and the DKIM DNS records.
- **AWS Systems Manager Parameter Store**: the destination address is resolved at deploy time; the CAPTCHA secrets are encrypted `SecureString` parameters that the function reads at runtime and caches for five minutes, so they never appear in the template or the function's environment.
- **Least-privilege IAM**: the function may only call the SES send actions for the configured identities, and read only the CAPTCHA secret parameters.
- **esbuild** (through CDK's `NodejsFunction`) bundles and minifies the handler, with a custom hook that ships the email template alongside it.

**Testing and CI**
- **Vitest** covers the request handling: unit tests for validation, CAPTCHA verification, secret loading, the email template and CORS; handler tests with SES, Parameter Store and Cloudflare mocked; and AWS CDK assertion tests on the synthesized template (runtime, CORS, throttling, IAM scope, no secrets).
- **GitHub Actions** runs the type check, the tests and `cdk synth` on every push to `main` and every pull request. Deployment stays a manual `cdk deploy`, as described in [DEPLOY.md](DEPLOY.md).

## Results and Impact

- **In use**: one deployment handles the contact forms of two separate sites, each with its own CAPTCHA configuration.
- **Spam filtered before email**: a submission is sent only if it passes field validation and the CAPTCHA check, including the site match.
- **Bounded exposure**: API-wide throttling (5 req/s, burst of 10) limits how far abuse or a misbehaving client can drive usage, without paying for a WAF.
- **Little to maintain**: no servers, no database, no admin dashboard. Messages arrive as emails, and replying is one click.
- **Reproducible**: the whole stack can be recreated from source with a single CDK deploy, once the required parameters exist.

No traffic or cost figures have been measured, so none are given here.

## Screenshots / Demo

No screenshots are included yet. Suggested additions, to be placed in a `docs/` folder and embedded here:

- A rendered notification email produced from [lambda/email-template.html](lambda/email-template.html).
- A short recording of a contact form submitting successfully.

## Links

- **Case study:** [portfolio.mario-gutierrez.com/portfolio/contact-api](https://portfolio.mario-gutierrez.com/portfolio/contact-api)
- **Deployment guide:** [DEPLOY.md](DEPLOY.md)
- **Live site:** none listed.

---

**Author:** Mario Gutiérrez, Backend Software Engineer
