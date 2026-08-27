# SES Setup

SES is optional. Outbound notifications and inbound email commands are separate capabilities; enable either, both, or neither. Core panel and server operations do not require SES.

## Capability Modes

### Disabled

```dotenv
SES_NOTIFICATIONS_ENABLED=false
SES_INBOUND_COMMANDS_ENABLED=false
```

This mode creates no SES receipt rules, receipt rule sets, SNS email trigger, or SES send permissions. Empty email settings never produce a catch-all or placeholder recipient.

### Outbound Notifications Only

```dotenv
SES_NOTIFICATIONS_ENABLED=true
SES_INBOUND_COMMANDS_ENABLED=false
VERIFIED_SENDER=<verified-sender-address>
NOTIFICATION_EMAIL=<notification-destination>
```

Verify `VERIFIED_SENDER` as an SES identity in the deployment region. The EC2 and lifecycle Lambda send policies are created only in this mode and are scoped to that sender identity ARN rather than all SES resources.

New SES accounts may be in the sandbox. Sandbox destinations generally must also be verified. See [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

### Inbound Commands Only

```dotenv
SES_NOTIFICATIONS_ENABLED=false
SES_INBOUND_COMMANDS_ENABLED=true
SES_INBOUND_RECIPIENT=<command-recipient-address>
SES_RECEIPT_RULE_SET_NAME=<existing-active-rule-set-name>
START_KEYWORD=<private-command-keyword>
```

Before deployment:

1. Choose a dedicated inbound subdomain, such as `commands.example.com`, unless the root domain already intentionally routes mail to SES. Changing a root-domain MX record can disrupt its existing email delivery.
2. Verify the **exact recipient domain** as an SES identity in the deployment region. Verification of a parent/root domain does not satisfy the setup preflight for a recipient on a subdomain.
3. Publish an MX record on that exact domain whose exchange is `inbound-smtp.<deployment-region>.amazonaws.com` (a trailing DNS dot is equivalent). It must be the sole exchange at the best/lowest numeric MX priority. A fallback exchange is allowed only at a strictly higher numeric priority; a non-SES exchange at a lower or equal priority fails preflight because mail could bypass SES.
4. Create or select a receipt rule set in that same region and activate it yourself.
5. Set `SES_RECEIPT_RULE_SET_NAME` to the exact active rule set name. The SNS topic used by an SES receipt rule must also be in the SES receiving region; the stack creates its project topic in the deployment region.

After the wizard reloads the environment and confirms AWS identity, `setup.sh` runs a read-only SES/DNS preflight before ownership-manifest initialization, migration preflight, or CDK deployment. `SES_INBOUND_COMMANDS_ENABLED` accepts only blank/omitted or the exact `false`/`true` literals (case-insensitive); other values fail rather than silently disabling the check. When inbound commands are disabled it explicitly reports that the check was skipped. When enabled it fails closed unless the region responds to SES, the exact domain identity has verification status `Success`, the configured rule set is active, and DNS uses the exact same-region SES inbound MX target as its sole best-priority exchange. The check only reads SES and public DNS; it never changes either. It does not print `START_KEYWORD` or AWS credentials.

The stack imports that rule set by name. It adds one project-owned rule for `SES_INBOUND_RECIPIENT`, routes matching mail through the project SNS topic to the lifecycle Lambda, and removes only that rule on stack deletion. It never creates, activates, deactivates, or replaces an account-wide receipt rule set.

### Sender authorization and authentication

An inbound command sender must be the configured `ADMIN_EMAIL` or be present in `ALLOWED_EMAILS` (or the runtime email allowlist). `NOTIFICATION_EMAIL` receives outbound notices but does not grant admin command authority or seed the allowlist. If upgrading a deployment where a distinct notification recipient was previously seeded into `/minecraft/email-allowlist`, remove it unless that address should retain start-only access. Configure the sender's domain so **SPF, DKIM, and DMARC all pass**. DMARC is required because it proves alignment with the visible `From` address used for authorization; independent SPF/DKIM success from an unrelated domain is insufficient.

`START_KEYWORD` is a command discriminator, not a reusable credential or sole authorization mechanism. Knowing or guessing it is insufficient: sender allowlisting and SPF, DKIM, and DMARC authentication are also required. The wizard reads it with hidden input, shows only `***` when retaining an existing value, and preserves that value when you press Enter. The inbound path does not log raw email subjects, and preflight does not print the keyword. Deployment stores the value in local environment files, the synthesized CloudFormation configuration, and the Lambda environment, where principals with the corresponding local or AWS read permissions can retrieve it. Protect that access and do not reuse a sensitive password or token as the keyword.

See [SES identity setup](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) and [SES email receiving](https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html).

### Both Capabilities

Set both capability flags to `true` and provide all outbound and inbound values. The sender and inbound recipient may be different identities.

## Existing Deployment Migration

Older mc-aws stacks created `MinecraftRuleSet`, activated it account-wide, and configured a fallback recipient. Do **not** update such a stack directly to this version: deleting the old activation custom resource can run its historical delete handler and deactivate the account-wide rule set.

Use the tested operator and staged CloudFormation procedure in [Existing Deployment Safety Migration](../EXISTING_DEPLOYMENT_MIGRATION.md). It first applies both Retain policies to exact legacy logical IDs without changing their properties, then proves and tags the live instance/root volume, and finally creates a reviewable current-template bridge with the complete deployed EC2 resource pinned.

Do not hand-build this bridge or run `setup.sh`/a normal CDK deployment before the migration. Repository deployment entry points intentionally block this legacy state.

This staged step is necessary because CloudFormation uses the previously deployed custom-resource delete behavior during a direct removal. Never work around it by automatically setting or clearing the active rule set.
