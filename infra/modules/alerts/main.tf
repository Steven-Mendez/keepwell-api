terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" {
  type = string
}

variable "email" {
  type = string
}

# Where every alarm of the environment goes. The email subscription must be confirmed once from the
# inbox (BOOTSTRAP.md).
resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.email
}

output "topic_arn" {
  value = aws_sns_topic.alerts.arn
}
