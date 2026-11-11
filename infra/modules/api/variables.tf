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

variable "provisioned_concurrency" {
  type = number
  # 0 until the account's Lambda concurrency quota is raised: new accounts get 10 concurrent
  # executions and AWS keeps 10 unreserved, so any provisioned instance is refused. Set to 1 once the
  # "Concurrent executions" quota (Service Quotas, Lambda) is above 10.
  default     = 0
  description = "Warm instances kept on the `live` alias (0 = none). Removes the cold start from the first request after idle; billed per hour whether used or not."
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
