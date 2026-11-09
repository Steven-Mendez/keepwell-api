variable "alarm_topic_arn" {
  type        = string
  default     = null
  description = "SNS topic for alarms"
}

# Separate from the topic ARN, which is unknown until the topic exists: count and for_each must be
# known at plan time.
variable "alarms" {
  type        = bool
  default     = false
  description = "Create the alarms (needs alarm_topic_arn)"
}

locals {
  alarms = !var.alarms ? {} : {
    server_errors = {
      description = "More than 5% of requests answered 5xx over 10 minutes"
      namespace   = "AWS/ApiGateway"
      metric      = "5xx"
      dimensions  = { ApiId = aws_apigatewayv2_api.http.id, Stage = "$default" }
      statistic   = "Average"
      threshold   = 0.05
      extended    = null
    }
    lambda_errors = {
      description = "The API function threw more than 3 times in 10 minutes"
      namespace   = "AWS/Lambda"
      metric      = "Errors"
      dimensions  = { FunctionName = aws_lambda_function.api.function_name }
      statistic   = "Sum"
      threshold   = 3
      extended    = null
    }
    p95_duration = {
      description = "p95 duration above 5 s for 10 minutes"
      namespace   = "AWS/Lambda"
      metric      = "Duration"
      dimensions  = { FunctionName = aws_lambda_function.api.function_name }
      statistic   = null
      threshold   = 5000
      extended    = "p95"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "api" {
  for_each            = local.alarms
  alarm_name          = "${var.name}-${replace(each.key, "_", "-")}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  extended_statistic  = each.value.extended
  period              = 300
  evaluation_periods  = 2
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

# Refusals are normal one at a time (an expired session, a forged webhook) and worrying in bulk:
# a burst means someone is probing the API or the webhook, or a client shipped with broken auth.
resource "aws_cloudwatch_log_metric_filter" "refusals" {
  count          = var.alarms ? 1 : 0
  name           = "${var.name}-refusals"
  log_group_name = aws_cloudwatch_log_group.access.name
  pattern        = "{ ($.status = \"401\") || ($.status = \"403\") }"
  metric_transformation {
    name          = "Refusals"
    namespace     = "Keepwell/${var.name}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "refusals" {
  count               = var.alarms ? 1 : 0
  alarm_name          = "${var.name}-refusals"
  alarm_description   = "More than ${var.refusal_threshold} answers of 401/403 in 10 minutes"
  namespace           = "Keepwell/${var.name}"
  metric_name         = "Refusals"
  statistic           = "Sum"
  period              = 600
  evaluation_periods  = 1
  threshold           = var.refusal_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

variable "refusal_threshold" {
  type        = number
  default     = 50
  description = "401/403 answers in 10 minutes above which someone should look"
  validation {
    condition     = var.refusal_threshold > 0
    error_message = "refusal_threshold must be positive."
  }
}
