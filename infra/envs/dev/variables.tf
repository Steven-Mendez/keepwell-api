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
  default     = ""
  description = "Registrable domain; the API answers on api.<domain> and the web on app.<domain>. Empty: no domain (web_origin proxies the API)"

  validation {
    condition     = var.domain == "" || can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain))
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

variable "web_origin" {
  type        = string
  default     = ""
  description = "Without a domain: the web app's origin (https://<project>.vercel.app), which proxies the API"
}
