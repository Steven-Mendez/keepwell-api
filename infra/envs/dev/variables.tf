variable "region" {
  type    = string
  default = "us-east-1"
}

variable "lambda_zip" {
  type    = string
  default = "../../../dist/lambda-api.zip"
}

variable "app_version" {
  type = string
}

variable "domain" {
  type = string
}
