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

variable "capabilities" {
  description = "Plan → capabilities table and early-access flags (ADR 0008). Not secret: versioned here."
  type = object({
    early_access = map(bool)
    plans        = map(list(string))
  })
  default = {
    early_access = { cloud_sync = true }
    plans = {
      free          = []
      supporter     = ["mcp"]
      pro           = ["cloud_sync", "mcp"]
      grandfathered = ["cloud_sync", "mcp"]
    }
  }
  validation {
    condition = alltrue([
      for capabilities in values(var.capabilities.plans) : alltrue([for c in capabilities : contains(["cloud_sync", "mcp"], c)])
    ]) && alltrue([for c in keys(var.capabilities.early_access) : contains(["cloud_sync", "mcp"], c)])
    error_message = "Capabilities are cloud_sync or mcp."
  }
}

# Changing it is a terraform apply of seconds; the API rereads it within a minute.
resource "aws_ssm_parameter" "capabilities" {
  name        = "${var.prefix}/capabilities"
  type        = "String"
  value       = jsonencode(var.capabilities)
  description = "Plans and capabilities (ADR 0008)"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Parameters whose values are set by hand (BOOTSTRAP.md). Terraform creates each one with the
# placeholder `unset` through a write-only argument, so no value ever enters the state; the API
# refuses to serve with a placeholder and GET /health says which key is missing.
locals {
  manual_parameters = {
    auth_secret        = { type = "SecureString", description = "Better Auth secret, 32+ random characters" }
    apple_private_key  = { type = "SecureString", description = "Sign in with Apple .p8 key, PEM with \\n" }
    apple_key_id       = { type = "String", description = "Key ID of the .p8 key" }
    apple_team_id      = { type = "String", description = "Apple developer team ID" }
    apple_services_id  = { type = "String", description = "Services ID used by the web (OAuth client_id)" }
    apple_bundle_id    = { type = "String", description = "iOS bundle identifier (audience of native ID tokens)" }
    allowed_apple_subs = { type = "String", description = "Comma-separated Apple user IDs allowed to sign in" }
  }
}

resource "aws_ssm_parameter" "manual" {
  for_each         = local.manual_parameters
  name             = "${var.prefix}/${each.key}"
  type             = each.value.type
  description      = each.value.description
  value_wo         = "unset"
  value_wo_version = 1
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
