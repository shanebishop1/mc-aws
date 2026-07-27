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

1. Verify the recipient's domain in SES in the deployment region.
2. Configure the domain's MX record for SES receiving.
3. Create or select a receipt rule set and activate it yourself.
4. Set `SES_RECEIPT_RULE_SET_NAME` to that exact existing rule set name.

The stack imports that rule set by name. It adds one project-owned rule for `SES_INBOUND_RECIPIENT`, routes matching mail through the project SNS topic to the lifecycle Lambda, and removes only that rule on stack deletion. It never creates, activates, deactivates, or replaces an account-wide receipt rule set.

See [SES identity setup](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) and [SES email receiving](https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html).

### Both Capabilities

Set both capability flags to `true` and provide all outbound and inbound values. The sender and inbound recipient may be different identities.

## Existing Deployment Migration

Older mc-aws stacks created `MinecraftRuleSet`, activated it account-wide, and configured a fallback recipient. Do **not** update such a stack directly to this version: deleting the old activation custom resource can run its historical delete handler and deactivate the account-wide rule set.

Use a staged CloudFormation migration:

1. From the old revision, deploy a bridge template that applies `DeletionPolicy: Retain` to both `MinecraftRuleSet` and `ActivateRuleSet` without changing the active rule set.
2. Confirm the retention policies are present in the deployed stack template.
3. Configure the desired capability flags. For inbound commands, explicitly name the receipt rule set that is already active (the retained set may be reused).
4. Deploy this revision. CloudFormation removes only the old project receipt rule; the retained rule set and activation resource are not deleted or invoked.
5. Manage the retained account-wide rule set manually thereafter. Remove any obsolete legacy rule only after confirming it belongs to this project.

This staged step is necessary because CloudFormation uses the previously deployed custom-resource delete behavior during a direct removal. Never work around it by automatically setting or clearing the active rule set.
