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
  type        = string
  default     = ""
  description = "Registrable domain with a Route 53 zone. Empty: no custom domain, the API is reached through the web app's proxy"
}

variable "hostname" {
  type        = string
  default     = ""
  description = "api.<domain> in prod, api.dev.<domain> in dev; unused without a domain"
}

variable "web_origin" {
  type        = string
  description = "The web app's origin, such as https://app.example.com or https://keepwell.vercel.app: the only CORS origin"
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.web_origin))
    error_message = "web_origin is https://<host>, with no path or trailing slash."
  }
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

variable "accept_sandbox_purchases" {
  type        = bool
  default     = true
  description = "Accept App Store Sandbox purchases. TestFlight and App Review buy in Sandbox against the production server, as Apple expects"
}

variable "app_store_app_id" {
  type        = string
  default     = ""
  description = "Apple ID of the app in App Store Connect; required to verify Production purchases"
}

variable "backups" {
  type        = bool
  default     = false
  description = "Daily AWS Backup copies of the cluster (the restore runbook relies on them)"
}

variable "deletion_protection" {
  type    = bool
  default = true
}

locals {
  name = "keepwell-${var.environment}"
  # With a domain, the API has its own host and shares the session cookie with app.<domain>. Without
  # one, the web app forwards the API's paths (next.config.ts), so clients see a single origin.
  custom_domain = var.domain != ""
  public_url    = local.custom_domain ? "https://${var.hostname}" : var.web_origin
}

module "api" {
  source     = "../api"
  name       = local.name
  lambda_zip = var.lambda_zip
  # Without them the module creates no alarms at all.
  alarm_topic_arn = module.alerts.topic_arn
  alarms          = true
  environment = {
    DB_HOST            = module.database.endpoint
    DB_USER            = "keepwell_app"
    CONFIG_PREFIX      = "/keepwell/${var.environment}"
    API_BASE_URL       = local.public_url
    WEB_ORIGIN         = var.web_origin
    COOKIE_DOMAIN      = var.domain
    QUEUE_URL          = module.queue.queue_url
    KEEPWELL_TIME_ZONE = var.time_zone
    APP_STORE_PRODUCTS = jsonencode(var.app_store_products)
    APP_STORE_APP_ID   = var.app_store_app_id
    APP_STORE_SANDBOX  = tostring(var.accept_sandbox_purchases)
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
  count     = local.custom_domain ? 1 : 0
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
  value       = local.custom_domain ? module.dns[0].url : local.public_url
  description = "Where clients reach the API"
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
