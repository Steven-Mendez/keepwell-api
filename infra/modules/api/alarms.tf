variable "alarm_topic_arn" {
  type        = string
  default     = null
  description = "SNS topic for alarms; none means no alarms"
}

locals {
  alarms = var.alarm_topic_arn == null ? {} : {
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
