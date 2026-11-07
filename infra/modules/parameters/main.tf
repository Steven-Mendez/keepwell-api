terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "prefix" {
  type        = string
  description = "Parameter path, such as /keepwell/prod"
}

variable "app_role_name" {
  type = string
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Secret parameters are created here with a placeholder through a write-only argument, so their
# value never enters the state. The real value is set by hand (BOOTSTRAP.md); the API refuses to
# start serving with the placeholder.
resource "aws_ssm_parameter" "auth_secret" {
  name             = "${var.prefix}/auth_secret"
  type             = "SecureString"
  value_wo         = "unset"
  value_wo_version = 1
  description      = "Better Auth secret. Set with: aws ssm put-parameter --overwrite"
}

resource "aws_iam_role_policy" "read" {
  name = "ssm-read"
  role = var.app_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = [
          "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${var.prefix}",
          "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${var.prefix}/*",
        ]
      },
      {
        # SecureStrings use the AWS-managed key; decrypt only through SSM.
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${data.aws_region.current.region}.amazonaws.com" } }
      },
    ]
  })
}

output "prefix" {
  value = var.prefix
}
