# SES Setup

SES email features are optional.

Use SES if you want:

- email-triggered start actions
- notification emails for server events

Core panel operations work without SES.

## 1. Verify An Email Or Domain

1. Open AWS SES in the same AWS region you use for this project.
2. Go to **Verified identities**.
3. Verify either an email address or a domain.

AWS docs:

- https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html

## 2. Understand The Sender Address

`VERIFIED_SENDER` is used as both:

- the email address SES receives mail for
- the sender address for notifications

Example:

```text
start@example.com
```

## 3. SES Sandbox

New SES accounts may be in sandbox mode. In sandbox mode, recipients usually need to be verified too.

AWS docs:

- https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html

## Values Needed Later

The setup wizard asks for optional values:

- `VERIFIED_SENDER`
- `NOTIFICATION_EMAIL`
- `START_KEYWORD`

Leave them empty to skip SES.
