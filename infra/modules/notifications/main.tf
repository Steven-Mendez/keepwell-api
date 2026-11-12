# The notifications job (ADR 0012): EventBridge Scheduler invokes its own Lambda every 15 minutes.
# Own role (logs, DSQL connect, SSM read), own log group, own alarms; the API role gets nothing here.
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" {
  type = string
}

variable "notifications_zip" {
  type = string
}

variable "db_endpoint" {
  type = string
}

variable "db_cluster_arn" {
  type = string
}

variable "parameter_prefix" {
  type        = string
  description = "Parameter path the configuration is read from, such as /keepwell/prod"
}

variable "time_zone" {
  type        = string
  description = "Zone for the ledger's recurring occurrences, as on the API"
}

variable "alarm_topic_arn" {
  type = string
}

variable "schedule" {
  type        = string
  default     = "rate(15 minutes)"
  description = "How often the job looks for notifications that are due"
}

variable "log_retention_days" {
  type    = number
  default = 90
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # A run is a pass over every person with a device; far under the next one.
  timeout = 120
}

# --- Function -------------------------------------------------------------------------------------

resource "aws_iam_role" "notifications" {
  name = "${var.name}-notifications"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_cloudwatch_log_group" "notifications" {
  name              = "/aws/lambda/${var.name}-notifications"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role_policy" "notifications" {
  name = "notifications"
  role = aws_iam_role.notifications.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.notifications.arn}:*" },
      { Effect = "Allow", Action = ["dsql:DbConnect"], Resource = var.db_cluster_arn },
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = [
          "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${var.parameter_prefix}",
          "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${var.parameter_prefix}/*",
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

resource "aws_lambda_function" "notifications" {
  function_name    = "${var.name}-notifications"
  role             = aws_iam_role.notifications.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = var.notifications_zip
  source_code_hash = filebase64sha256(var.notifications_zip)
  publish          = true
  memory_size      = 512
  timeout          = local.timeout

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.notifications.name
  }

  environment {
    variables = {
      DB_HOST            = var.db_endpoint
      DB_USER            = "keepwell_app"
      CONFIG_PREFIX      = var.parameter_prefix
      KEEPWELL_TIME_ZONE = var.time_zone
      NODE_OPTIONS       = "--enable-source-maps"
    }
  }

  # As the other functions: Terraform creates it once, the pipeline publishes code afterwards.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [aws_iam_role_policy.notifications]
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.notifications.function_name
  function_version = aws_lambda_function.notifications.version
  lifecycle {
    ignore_changes = [function_version]
  }
}

# --- Schedule -------------------------------------------------------------------------------------

resource "aws_iam_role" "scheduler" {
  name = "${var.name}-notifications-scheduler"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "scheduler.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = [aws_lambda_alias.live.arn, aws_lambda_function.notifications.arn] }]
  })
}

resource "aws_scheduler_schedule" "notifications" {
  name                = "${var.name}-notifications"
  description         = "Sends the notifications that are due (ADR 0012)"
  schedule_expression = var.schedule

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_alias.live.arn
    role_arn = aws_iam_role.scheduler.arn
    # A retry is safe: each delivery is recorded before it is sent, so a rerun skips what went out.
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 600
    }
  }
}

# --- Alarms ---------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${var.name}-notifications-errors"
  alarm_description   = "The notifications job errored in 3 of its last 4 runs (every person failing, or configuration not loading)"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.notifications.function_name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 4
  datapoints_to_alarm = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

# No runs at all (a disabled schedule, a broken role) is as bad as failing ones: nobody is notified.
resource "aws_cloudwatch_metric_alarm" "silent" {
  alarm_name          = "${var.name}-notifications-not-running"
  alarm_description   = "The notifications job didn't run in the last hour"
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = aws_lambda_function.notifications.function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

output "role_arn" {
  value       = aws_iam_role.notifications.arn
  description = "Mapped to the keepwell_app database role by the migrator"
}

output "function_name" {
  value = aws_lambda_function.notifications.function_name
}
