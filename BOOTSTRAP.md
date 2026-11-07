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
for env in dev prod; do
  aws ssm put-parameter --overwrite --type SecureString \
    --name /keepwell/$env/auth_secret --value "$(openssl rand -base64 48)"
done
```

`GET /health` answers `config: error` until the real values are in place.
