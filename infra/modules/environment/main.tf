# One environment, the same for dev and prod: envs/<env> only sets the backend and variables.
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "environment" {
  type = string
}

variable "domain" {
  type = string
}

variable "hostname" {
  type        = string
  description = "api.<domain> in prod, api.dev.<domain> in dev"
}

variable "lambda_zip" {
  type = string
}

variable "app_version" {
  type = string
}

variable "deletion_protection" {
  type    = bool
  default = true
}

locals {
  name = "keepwell-${var.environment}"
}

module "api" {
  source      = "../api"
  name        = local.name
  lambda_zip  = var.lambda_zip
  app_version = var.app_version
  environment = {
    DB_HOST = module.database.endpoint
    DB_USER = "keepwell_app"
  }
}

module "dns" {
  source    = "../dns"
  zone_name = var.domain
  hostname  = var.hostname
  api_id    = module.api.api_id
  stage_id  = module.api.stage_id
}

module "database" {
  source              = "../database"
  name                = local.name
  app_role_name       = module.api.role_name
  deletion_protection = var.deletion_protection
}

output "api_url" {
  value = module.dns.url
}

output "api_endpoint" {
  value = module.api.endpoint
}

output "db_endpoint" {
  value = module.database.endpoint
}

output "app_role_arn" {
  value = module.api.role_arn
}
