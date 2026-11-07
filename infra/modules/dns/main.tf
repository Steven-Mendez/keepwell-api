terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "zone_name" {
  type        = string
  description = "Registrable domain whose Route 53 zone was created in the bootstrap"
}

variable "hostname" {
  type        = string
  description = "Full API hostname, such as api.example.com or api.dev.example.com"
}

variable "api_id" {
  type = string
}

variable "stage_id" {
  type = string
}

data "aws_route53_zone" "this" {
  name         = var.zone_name
  private_zone = false
}

resource "aws_acm_certificate" "api" {
  domain_name       = var.hostname
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for option in aws_acm_certificate.api.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      type   = option.resource_record_type
      record = option.resource_record_value
    }
  }
  zone_id         = data.aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "api" {
  domain_name = var.hostname
  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.api.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "api" {
  api_id      = var.api_id
  domain_name = aws_apigatewayv2_domain_name.api.id
  stage       = var.stage_id
}

resource "aws_route53_record" "api" {
  for_each = toset(["A", "AAAA"])
  zone_id  = data.aws_route53_zone.this.zone_id
  name     = var.hostname
  type     = each.key
  alias {
    name                   = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

output "url" {
  value = "https://${var.hostname}"
}
