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

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.app_version))
    error_message = "app_version must be a git commit SHA."
  }
}

variable "alert_email" {
  type        = string
  description = "Receives budget and alarm notifications"

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "domain" {
  type        = string
  description = "Registrable domain; the API answers on api.<domain> and the web on app.<domain>"

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain must be a bare registrable domain such as example.com (no scheme, no api.)."
  }
}
