terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" {
  type = string
}

variable "jobs_zip" {
  type = string
}

variable "app_version" {
  type = string
}

variable "db_endpoint" {
  type = string
}

variable "db_cluster_arn" {
  type = string
}

variable "api_role_name" {
  type        = string
  description = "Granted sqs:SendMessage on the queue, nothing else"
}

variable "alarm_topic_arn" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}

locals {
  job_timeout = 120
}

# --- Queues ---------------------------------------------------------------------------------------

resource "aws_sqs_queue" "dead_letters" {
  name                      = "${var.name}-jobs-dlq"
  message_retention_seconds = 14 * 24 * 3600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name}-jobs"
  visibility_timeout_seconds = local.job_timeout * 6
  message_retention_seconds  = 4 * 24 * 3600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letters.arn
    maxReceiveCount     = 5
  })
}

# A message in the DLQ means an account that asked to be deleted still isn't: page someone.
resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  alarm_name          = "${var.name}-jobs-dlq-not-empty"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dead_letters.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

resource "aws_iam_role_policy" "api_send" {
  name = "sqs-send-jobs"
  role = var.api_role_name
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.jobs.arn }]
  })
}

# --- Consumer -------------------------------------------------------------------------------------

resource "aws_iam_role" "jobs" {
  name = "${var.name}-jobs"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_cloudwatch_log_group" "jobs" {
  name              = "/aws/lambda/${var.name}-jobs"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role_policy" "jobs" {
  name = "jobs"
  role = aws_iam_role.jobs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.jobs.arn}:*" },
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.jobs.arn },
      { Effect = "Allow", Action = ["dsql:DbConnect"], Resource = var.db_cluster_arn },
    ]
  })
}

resource "aws_lambda_function" "jobs" {
  function_name    = "${var.name}-jobs"
  role             = aws_iam_role.jobs.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = var.jobs_zip
  source_code_hash = filebase64sha256(var.jobs_zip)
  memory_size      = 512
  timeout          = local.job_timeout
  # Deletions are rare; two at a time keeps DSQL's connection rate and conflicts low.
  reserved_concurrent_executions = 2

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.jobs.name
  }

  environment {
    variables = {
      APP_VERSION  = var.app_version
      DB_HOST      = var.db_endpoint
      DB_USER      = "keepwell_app"
      NODE_OPTIONS = "--enable-source-maps"
    }
  }

  depends_on = [aws_iam_role_policy.jobs]
}

resource "aws_lambda_event_source_mapping" "jobs" {
  event_source_arn        = aws_sqs_queue.jobs.arn
  function_name           = aws_lambda_function.jobs.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}

output "queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "jobs_role_arn" {
  value = aws_iam_role.jobs.arn
}
