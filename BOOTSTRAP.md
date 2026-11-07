# Bootstrap

What the pipeline can't create because it depends on it. Done once, from a laptop, with an
administrator profile. Everything after this enters through commits.

## 1. Domain

Register the domain (or move its DNS) to Route 53 and keep the hosted zone. Only the zone: the API
records are created by Terraform when the `dns` module comes in.

## 2. State bucket and GitHub roles

```bash
cd infra/bootstrap
terraform init
terraform apply \
  -var github_repository=<owner>/keepwell-api \
  -var state_bucket=keepwell-tfstate-<account-id>
```

State for this stack stays local (`infra/bootstrap/terraform.tfstate`, git-ignored). Keep a copy in
a password manager; losing it only means importing three resources by hand.

Outputs: the bucket name and the ARNs of two roles.

| Role                 | Trusted subject                         | Can                                                         |
| -------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `keepwell-ci-plan`   | `repo:<owner>/keepwell-api:pull_request` | read state and resources, `terraform plan -lock=false`      |
| `keepwell-ci-deploy` | `repo:<owner>/keepwell-api:ref:refs/heads/main` | apply the project's resources, run migrations       |

## 3. GitHub repository

Create `keepwell-api` on GitHub and set these **variables** (not secrets; none of them is one):

| Variable              | Value                                  |
| --------------------- | -------------------------------------- |
| `AWS_PLAN_ROLE_ARN`   | `plan_role_arn` output                 |
| `AWS_DEPLOY_ROLE_ARN` | `deploy_role_arn` output               |
| `TF_STATE_BUCKET`     | `state_bucket` output                  |
| `ALERT_EMAIL`         | where budget and alarm emails go       |
| `DOMAIN`              | the registrable domain of step 1       |

Protect `main`: pull requests only, `check` and `plan` required.

## Outside Terraform, documented here

These steps are added as the increments that need them land.

### Secrets in SSM (increment 4 onward)

Terraform creates each secret parameter with the placeholder `unset` through a write-only
argument, so values never reach the state. After the first deploy of each environment, set them:

```bash
put() { aws ssm put-parameter --overwrite --name "/keepwell/$1/$2" --type "$3" --value "$4"; }
for env in dev prod; do
  put $env auth_secret SecureString "$(openssl rand -base64 48)"
  put $env apple_private_key SecureString "$(awk '{printf "%s\\n", $0}' AuthKey_XXXXXXXXXX.p8)"
  put $env apple_key_id String XXXXXXXXXX
  put $env apple_team_id String YYYYYYYYYY
  put $env apple_services_id String <services id, e.g. app.keepwell.web>
  put $env apple_bundle_id String <iOS bundle id>
  put $env allowed_apple_subs String ""   # filled in step 5
done
```

### Sign in with Apple (increment 5)

In the Apple developer portal:

1. Enable Sign in with Apple on the iOS App ID.
2. Create a **Services ID** for the web, with Sign in with Apple enabled, domain `api.<domain>` and
   return URL `https://api.<domain>/api/auth/callback/apple` (and the `api.dev.` equivalents).
3. Create a **key** with Sign in with Apple; download the `.p8` once. Its key ID and the team ID
   go to SSM above.
4. Deploy, then try to sign in from the web. You are rejected (registration is closed) and the
   attempt is recorded in `audit_log` with your Apple `sub`:
   `select details from audit_log where action = 'signin.rejected' order by at desc limit 1`.
5. Put that `sub` in `allowed_apple_subs` and sign in again. Configuration is read at cold start:
   `aws lambda update-function-configuration --function-name keepwell-<env>-api --description "reload $(date +%s)"`
   recycles the instances.

`GET /health` answers `config: error` until the real values are in place.

### Alerts (increment 7 onward)

Each environment creates an SNS topic `keepwell-<env>-alerts` subscribed to `ALERT_EMAIL`. AWS
sends a confirmation email after the first deploy; confirm it, or alarms go nowhere.

### App Store (increments 23–25)

1. In App Store Connect create the non-consumable product `app.keepwell.coffee` ("Invítame un café").
   Another id needs `app_store_products` in the environment module (product id → plan).
2. Set `app_store_app_id` to the app's Apple ID (App Information → Apple ID). Without it
   Production purchases cannot be verified; Sandbox ones (dev, TestFlight) can.
3. App Store Server Notifications V2: Production URL `https://api.<domain>/webhooks/app-store`,
   Sandbox URL `https://api.dev.<domain>/webhooks/app-store`. Use "Request a Test Notification"
   and look for `app_store.notification` in the logs.
4. Apple's root certificate lives in `certs/` with its fingerprint; a test checks the copy in code
   matches it byte for byte.

dev accepts Sandbox purchases; prod refuses them (`APP_STORE_SANDBOX`).

### Invitations (increment 26)

Registration stays closed: the allowlist in SSM (`allowed_apple_subs`), people who already have an
account, and single-use invitations.

```sh
DB_HOST=<cluster endpoint> AWS_REGION=us-east-1 pnpm invite 7 "for Ana"   # prints the code once
```

The person types the code on the iPhone (sent as `x-keepwell-invitation` with the Apple ID token) or
on the web (`POST /invitations/claim` keeps it in a 30-minute cookie for Apple's redirect). The code
is consumed when the account is created; only its SHA-256 is stored.

**Before the first external user**, put CloudFront with AWS WAF (AWS managed common rules and a
rate-based rule per IP) in front of the HTTP API. Not built while the only users are the author and
invited friends: API Gateway throttling, the 401/403 alarm and invite-only registration cover that
stage, and WAF costs a fixed monthly fee. Section 5 of PLAN_API.md is the checklist to complete first.
