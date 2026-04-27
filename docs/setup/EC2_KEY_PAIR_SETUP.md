# EC2 Key Pair Setup

An EC2 key pair is optional. Create one only if you want SSH key access to the instance.

Most day-to-day operations should happen through the web panel, CLI, or SSM-based scripts.

## Create A Key Pair

1. Open AWS Console.
2. Go to **EC2 -> Key Pairs**.
3. Click **Create key pair**.
4. Enter a name, for example `mc-aws`.
5. Use RSA and `.pem` unless you have a reason to choose otherwise.
6. Download the private key.
7. Store it securely. AWS will not show it again.

AWS docs:

- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-key-pairs.html

## Value Needed Later

The setup wizard may ask for:

- `KEY_PAIR_NAME`

If you skip it, the CDK stack can still create the instance without attaching an EC2 key pair.
