# Applied once from a laptop with local state (see BOOTSTRAP.md). Everything the pipeline needs
# before it can run itself: the state bucket and the two GitHub OIDC roles. Nothing else lives here.

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = var.project, managed_by = "terraform", stack = "bootstrap" }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "keepwell"
}

variable "github_repository" {
  type = string
  # GitHub repositories created with immutable OIDC subjects send `repo:owner@<id>/name@<id>:…`
  # (gh api repos/<owner>/<name>/actions/oidc/customization/sub shows the prefix); pass that form.
  description = "The repository as the OIDC subject names it: owner/name, or owner@<id>/name@<id> with immutable subjects"
}

variable "state_bucket" {
  type        = string
  description = "Globally unique name for the Terraform state bucket"
}

data "aws_caller_identity" "current" {}

# --- State bucket: versioned, encrypted, private, TLS only ---------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# --- GitHub Actions OIDC --------------------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  oidc_sub_claim = "token.actions.githubusercontent.com:sub"
  oidc_aud_claim = "token.actions.githubusercontent.com:aud"
}

data "aws_iam_policy_document" "trust_pull_request" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = local.oidc_aud_claim
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = local.oidc_sub_claim
      values   = ["repo:${var.github_repository}:pull_request"]
    }
  }
}

data "aws_iam_policy_document" "trust_main" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = local.oidc_aud_claim
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = local.oidc_sub_claim
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

# Pull requests: `terraform plan -lock=false` and nothing else. Read-only everywhere, plus reading
# the state objects.
resource "aws_iam_role" "plan" {
  name                 = "${var.project}-ci-plan"
  assume_role_policy   = data.aws_iam_policy_document.trust_pull_request.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_read_only" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy" "plan_state" {
  name = "read-state"
  role = aws_iam_role.plan.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.state.arn },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.state.arn}/*" },
      # SSM SecureString values are never read by plan: parameters use ignore_changes on value.
      { Effect = "Deny", Action = ["ssm:GetParameter*"], Resource = "*", Condition = { Bool = { "ssm:WithDecryption" = "true" } } },
    ]
  })
}

# main: migrations and `terraform apply`, limited to the project's own resources where the service
# allows naming them, and to this region otherwise.
resource "aws_iam_role" "deploy" {
  name                 = "${var.project}-ci-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust_main.json
  max_session_duration = 3600
}

locals {
  account = data.aws_caller_identity.current.account_id
  prefix  = var.project
}

resource "aws_iam_role_policy" "deploy" {
  name = "deploy-project"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "State"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      },
      {
        Sid    = "ProjectRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:TagRole", "iam:UntagRole",
          "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
          "iam:ListInstanceProfilesForRole", "iam:PassRole", "iam:UpdateAssumeRolePolicy",
        ]
        Resource = "arn:aws:iam::${local.account}:role/${local.prefix}-*"
      },
      {
        Sid    = "ProjectFunctionsLogsQueuesParameters"
        Effect = "Allow"
        Action = ["lambda:*", "logs:*", "sqs:*", "ssm:*", "cloudwatch:*", "sns:*"]
        Resource = [
          "arn:aws:lambda:${var.region}:${local.account}:function:${local.prefix}-*",
          "arn:aws:logs:${var.region}:${local.account}:log-group:/aws/lambda/${local.prefix}-*",
          "arn:aws:logs:${var.region}:${local.account}:log-group:/aws/lambda/${local.prefix}-*:*",
          "arn:aws:logs:${var.region}:${local.account}:log-group:/aws/apigateway/${local.prefix}-*",
          "arn:aws:logs:${var.region}:${local.account}:log-group:/aws/apigateway/${local.prefix}-*:*",
          "arn:aws:sqs:${var.region}:${local.account}:${local.prefix}-*",
          "arn:aws:ssm:${var.region}:${local.account}:parameter/${local.prefix}/*",
          "arn:aws:cloudwatch:${var.region}:${local.account}:alarm:${local.prefix}-*",
          # The alerts topic and its subscriptions (topic ARN plus `:<subscription id>`).
          "arn:aws:sns:${var.region}:${local.account}:${local.prefix}-*",
        ]
      },
      {
        # The jobs queue's trigger: event source mappings are named by a UUID, never by the project
        # prefix, so they can't be held to it; creating and listing them names no resource at all.
        Sid    = "QueueTriggers"
        Effect = "Allow"
        Action = [
          "lambda:CreateEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:UpdateEventSourceMapping",
          "lambda:DeleteEventSourceMapping", "lambda:ListEventSourceMappings", "lambda:TagResource",
          "lambda:UntagResource", "lambda:ListTags",
        ]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        # These services either don't support resource-level names on create (API Gateway, ACM,
        # DSQL, Backup) or are account-wide lists (Describe*). Held to this region.
        Sid    = "RegionalServices"
        Effect = "Allow"
        Action = [
          "apigateway:*", "acm:*", "dsql:*", "backup:*", "backup-storage:*",
          "logs:DescribeLogGroups", "logs:ListTagsForResource", "lambda:GetLayerVersion",
          "cloudwatch:DescribeAlarms", "ssm:DescribeParameters", "kms:DescribeKey", "kms:CreateGrant",
          "kms:GenerateDataKey", "kms:Decrypt",
        ]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid      = "GlobalServices"
        Effect   = "Allow"
        Action   = ["route53:*", "budgets:*", "iam:CreateServiceLinkedRole", "iam:ListRoles", "iam:GetPolicy", "iam:GetPolicyVersion"]
        Resource = "*"
      },
    ]
  })
}

output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "plan_role_arn" { value = aws_iam_role.plan.arn }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
