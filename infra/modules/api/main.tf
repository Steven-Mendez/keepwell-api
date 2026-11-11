data "aws_region" "current" {}

# --- Function -------------------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.name}-api"
  retention_in_days = var.log_retention_days
}

# Writes its own log group and nothing else; each later capability (database, parameters, queue)
# adds its own statement in the module that owns the resource.
resource "aws_iam_role_policy" "api_logs" {
  name = "logs"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.api.arn}:*"
    }]
  })
}

resource "aws_lambda_function" "api" {
  function_name = "${var.name}-api"
  role          = aws_iam_role.api.arn
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  filename      = var.lambda_zip
  # Terraform creates the function with the first build; from then on the pipeline publishes code
  # (scripts/deploy-code.sh) after migrations, and moves the `live` alias. Terraform keeps owning
  # its configuration.
  source_code_hash = filebase64sha256(var.lambda_zip)
  memory_size      = var.memory_mb
  # Below API Gateway's 29 s so the function answers (even partially) before the gateway gives up.
  timeout = 25
  publish = true

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.api.name
  }

  environment {
    variables = merge(var.environment, {
      NODE_OPTIONS = "--enable-source-maps"
    })
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [aws_iam_role_policy.api_logs]
}

# What API Gateway invokes. The pipeline points it at each new version; rollback points it back.
resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.api.function_name
  function_version = aws_lambda_function.api.version
  lifecycle {
    ignore_changes = [function_version]
  }
}

# One instance kept initialised on the alias API Gateway calls, so a request after idle doesn't pay
# the cold start (init, database connection, Better Auth). Traffic beyond it still scales out on
# demand. The pipeline moves the alias to each new version; Lambda re-provisions the instance on it
# and scripts/deploy-code.sh waits until that is READY before the smoke test.
resource "aws_lambda_provisioned_concurrency_config" "live" {
  count                             = var.provisioned_concurrency > 0 ? 1 : 0
  function_name                     = aws_lambda_function.api.function_name
  qualifier                         = aws_lambda_alias.live.name
  provisioned_concurrent_executions = var.provisioned_concurrency
}

# --- HTTP API -------------------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name}-http"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_alias.live.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

# One catch-all route: Hono owns routing, so a new endpoint never needs a Terraform change.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}-http"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.throttle_rate
    throttling_burst_limit = var.throttle_burst
  }

  # No query strings, headers or bodies: paths and status codes only.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      request_id = "$context.requestId"
      time       = "$context.requestTime"
      method     = "$context.httpMethod"
      route      = "$context.routeKey"
      path       = "$context.path"
      status     = "$context.status"
      latency_ms = "$context.responseLatency"
      error      = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  qualifier     = aws_lambda_alias.live.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
