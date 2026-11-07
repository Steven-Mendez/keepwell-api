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

variable "web_hostname" {
  type        = string
  description = "app.<domain> in prod, app.dev.<domain> in dev: the only CORS origin"
}

variable "lambda_zip" {
  type = string
}

variable "app_version" {
  type = string
}

variable "jobs_zip" {
  type = string
}

variable "alert_email" {
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
    DB_HOST       = module.database.endpoint
    DB_USER       = "keepwell_app"
    CONFIG_PREFIX = "/keepwell/${var.environment}"
    API_BASE_URL  = "https://${var.hostname}"
    WEB_ORIGIN    = "https://${var.web_hostname}"
    COOKIE_DOMAIN = var.domain
    QUEUE_URL     = module.queue.queue_url
  }
}

module "alerts" {
  source = "../alerts"
  name   = local.name
  email  = var.alert_email
}

module "queue" {
  source          = "../queue"
  name            = local.name
  jobs_zip        = var.jobs_zip
  app_version     = var.app_version
  db_endpoint     = module.database.endpoint
  db_cluster_arn  = module.database.arn
  api_role_name   = module.api.role_name
  alarm_topic_arn = module.alerts.topic_arn
}

module "parameters" {
  source        = "../parameters"
  prefix        = "/keepwell/${var.environment}"
  app_role_name = module.api.role_name
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
  value       = join(",", [module.api.role_arn, module.queue.jobs_role_arn])
  description = "IAM roles mapped to keepwell_app by the migrator: the API and the jobs consumer"
}
