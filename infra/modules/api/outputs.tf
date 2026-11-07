output "endpoint" {
  value       = aws_apigatewayv2_api.http.api_endpoint
  description = "Default execute-api URL"
}

output "api_id" {
  value = aws_apigatewayv2_api.http.id
}

output "stage_id" {
  value = aws_apigatewayv2_stage.default.id
}

output "function_name" {
  value = aws_lambda_function.api.function_name
}

output "role_name" {
  value       = aws_iam_role.api.name
  description = "Execution role; other modules attach their own statements to it"
}

output "role_arn" {
  value = aws_iam_role.api.arn
}
