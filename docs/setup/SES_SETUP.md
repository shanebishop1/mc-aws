# Optional SES Setup

SES is not required. Outbound notifications and inbound email commands can be enabled independently.

## Outbound notifications

Verify the exact sender identity in SES in the deployment region. New SES accounts may be in the sandbox, where the destination usually must also be verified. Setup asks for the verified sender and notification destination.

## Inbound commands

Before setup:

1. Use a dedicated inbound subdomain such as `commands.example.com` unless the root domain intentionally routes all mail to SES. Changing a root-domain MX record can break existing mail delivery.
2. Verify the **exact recipient domain** in SES in the deployment region. Verifying only its parent domain does not satisfy the prerequisite check.
3. Publish MX for that exact domain to `inbound-smtp.<region>.amazonaws.com`. It must be the only best/lowest-priority exchange; fallback records must have a higher numeric priority.
4. Create and activate a receipt rule set in the same region.
5. Configure authorized sender domains so SPF, DKIM, and DMARC pass. DMARC alignment with the visible `From` address is required.

Setup asks for the recipient, active rule-set name, and private start keyword. Accepted subjects are `<start-keyword>`, `backup [name]`, `restore [name]`, `hibernate`, `resume`, and admin-only `allowlist` with addresses in the body. Only `ADMIN_EMAIL` may use every command; other allowed senders may use only the exact start-keyword subject. Every sender must pass SPF, DKIM, and DMARC.

When inbound commands are enabled, setup checks the prerequisites: regional SES access, exact-domain verification, the active rule set, and the same-region MX target. It does not create or activate a rule set. The stack adds and later removes only its own receipt rule.

For a legacy stack that created or activated a receipt rule set, do not run normal setup first. Follow [Existing Deployment Migration](../EXISTING_DEPLOYMENT_MIGRATION.md).

References: [SES identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), [email receiving](https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html), and [production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
