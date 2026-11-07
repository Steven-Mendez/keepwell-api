# Secret rotation

Last rehearsed: not yet (before opening registration).

Secrets live in SSM Parameter Store under `/keepwell/<env>/`, never in Terraform state. The Lambda
reads them at cold start, so new values take effect when instances are recycled:

```bash
aws lambda update-function-configuration --function-name keepwell-$ENV-api --description "rotate $(date +%s)"
aws lambda wait function-updated-v2 --function-name keepwell-$ENV-api
```

## `auth_secret` (Better Auth)

Signs session cookies and the OAuth query. Rotating it signs everyone out of the apps and makes
in-flight OAuth consents fail; refresh tokens and stored data are unaffected.

```bash
aws ssm put-parameter --overwrite --type SecureString \
  --name /keepwell/$ENV/auth_secret --value "$(openssl rand -base64 48)"
# recycle instances (above), then sign in again on each device
```

## Sign in with Apple key (`apple_private_key`, `apple_key_id`)

Apple allows two active keys. No downtime:

1. Create a new key in the developer portal (Sign in with Apple enabled), download the `.p8`.
2. Put both values in SSM (`apple_private_key`, `apple_key_id`) and recycle instances. The client
   secret is minted from the new key at cold start.
3. Sign in on the web to check, then revoke the old key in the portal.

## OAuth signing keys (`jwkss` table)

Better Auth's `jwt` plugin rotates its own keys. To force it (a key leaked): delete the row from
`jwkss`; MCP clients get 401 and refresh, and every access token signed with it stops verifying.

## AWS credentials

There are none to rotate: the pipeline uses OIDC, the Lambdas their roles, DSQL IAM tokens. If a
person's console credentials leaked, rotate them in IAM Identity Center and check CloudTrail.
