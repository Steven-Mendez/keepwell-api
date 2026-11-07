variable "region" {
  type    = string
  default = "us-east-1"
}

variable "lambda_zip" {
  type    = string
  default = "../../../dist/lambda-api.zip"
}

variable "jobs_zip" {
  type    = string
  default = "../../../dist/lambda-jobs.zip"
}

variable "app_version" {
  type        = string
  description = "Commit SHA being deployed"
}

variable "alert_email" {
  type        = string
  description = "Receives budget and alarm notifications"
}

variable "domain" {
  type        = string
  description = "Registrable domain; the API answers on api.<domain> and the web on app.<domain>"
}
