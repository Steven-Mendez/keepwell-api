variable "name" {
  type        = string
  description = "Resource name prefix, such as keepwell-prod"
}

variable "lambda_zip" {
  type        = string
  description = "Path to the bundled API zip built by scripts/build.mjs"
}


variable "memory_mb" {
  type    = number
  default = 512
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "throttle_rate" {
  type    = number
  default = 50
}

variable "throttle_burst" {
  type    = number
  default = 100
}

variable "environment" {
  type        = map(string)
  default     = {}
  description = "Extra non-secret environment variables for the function"
}
