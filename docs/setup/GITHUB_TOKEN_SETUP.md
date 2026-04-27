# GitHub Token Setup

The setup flow stores a GitHub token in AWS SSM so the EC2 instance can clone your repo.

## Create A Token

1. Open GitHub.
2. Go to **Settings -> Developer settings -> Personal access tokens**.
3. Create a token that can read your fork.
4. If you use a classic token, select the `repo` scope.
5. Copy the token. GitHub only shows it once.

GitHub docs:

- https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens

## Values Needed Later

The setup wizard asks for:

- `GITHUB_USER`
- `GITHUB_REPO`
- `GITHUB_TOKEN`

## Notes

- Treat the token like a password.
- Do not commit it.
- If you rotate it later, update the value in your env file and redeploy the relevant infrastructure/secrets.
- The current setup path requires this token for deployment because CDK seeds it into SSM for the instance.
