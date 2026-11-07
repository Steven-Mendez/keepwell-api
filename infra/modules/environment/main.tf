# One environment, the same for dev and prod: envs/<env> only sets the backend and variables.
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment is dev or prod."
  }
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


variable "jobs_zip" {
  type = string
}

variable "alert_email" {
  type = string
}

variable "time_zone" {
  type        = string
  default     = "America/Managua"
  description = "The person's time zone, for calendar math such as recurring occurrences"
}

variable "app_store_products" {
  type        = map(string)
  default     = { "app.keepwell.coffee" = "supporter" }
  description = "App Store product id → plan it grants"
  validation {
    condition     = alltrue([for plan in values(var.app_store_products) : contains(["free", "supporter"], plan)])
    error_message = "Each product must grant a known plan (free or supporter)."
  }
}

variable "app_store_app_id" {
  type        = string
  default     = ""
  description = "Apple ID of the app in App Store Connect; required to verify Production purchases"
}

variable "backups" {
  type        = bool
  default     = false
  description = "Daily AWS Backup copies of the cluster (prod only: dev holds test data)"
}

variable "deletion_protection" {
  type    = bool
  default = true
}

locals {
  name = "keepwell-${var.environment}"
}

module "api" {
  source     = "../api"
  name       = local.name
  lambda_zip = var.lambda_zip
  # Without it the module creates no alarms at all.
  alarm_topic_arn = module.alerts.topic_arn
  environment = {
    DB_HOST            = module.database.endpoint
    DB_USER            = "keepwell_app"
    CONFIG_PREFIX      = "/keepwell/${var.environment}"
    API_BASE_URL       = "https://${var.hostname}"
    WEB_ORIGIN         = "https://${var.web_hostname}"
    COOKIE_DOMAIN      = var.domain
    QUEUE_URL          = module.queue.queue_url
    KEEPWELL_TIME_ZONE = var.time_zone
    APP_STORE_PRODUCTS = jsonencode(var.app_store_products)
    APP_STORE_APP_ID   = var.app_store_app_id
    # TestFlight and Xcode purchases are Sandbox; only prod refuses them.
    APP_STORE_SANDBOX = tostring(var.environment != "prod")
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
  db_endpoint     = module.database.endpoint
  db_cluster_arn  = module.database.arn
  api_role_name   = module.api.role_name
  alarm_topic_arn = module.alerts.topic_arn
}

module "backup" {
  count           = var.backups ? 1 : 0
  source          = "../backup"
  name            = local.name
  cluster_arn     = module.database.arn
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
  value       = module.api.role_arn
  description = "Mapped to the keepwell_app database role by the migrator"
}

output "jobs_role_arn" {
  value       = module.queue.jobs_role_arn
  description = "Mapped to the keepwell_jobs database role by the migrator"
}

output "api_function" {
  value = module.api.function_name
}

output "jobs_function" {
  value = "${local.name}-jobs"
}

output "backup_vault" {
  value = var.backups ? module.backup[0].vault_name : null
}
