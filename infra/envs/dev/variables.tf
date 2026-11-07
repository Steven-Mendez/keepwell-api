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

variable "domain" {
  type        = string
  description = "Registrable domain; the API answers on api.<domain> and the web on app.<domain>"

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain must be a bare registrable domain such as example.com (no scheme, no api.)."
  }
}

variable "alert_email" {
  type        = string
  description = "Receives alarm notifications"

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}
