provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "keepwell", environment = "prod", managed_by = "terraform" }
  }
}

module "environment" {
  source      = "../../modules/environment"
  environment = "prod"
  domain      = var.domain
  hostname    = var.domain == "" ? "" : "api.${var.domain}"
  web_origin  = var.domain == "" ? var.web_origin : "https://app.${var.domain}"
  lambda_zip  = var.lambda_zip
  jobs_zip    = var.jobs_zip
  alert_email = var.alert_email
  # Daily AWS Backup copies kept 35 days (docs/runbooks/restore.md).
  backups = true
}

# An abuse shows up on the bill first. Account-wide, so it lives with prod only.
resource "aws_budgets_budget" "monthly" {
  name         = "keepwell-monthly"
  budget_type  = "COST"
  limit_amount = "10"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}
