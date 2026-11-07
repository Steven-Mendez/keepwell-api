terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" {
  type = string
}

variable "app_role_name" {
  type        = string
  description = "Execution role of the API Lambda, granted dsql:DbConnect (never DbConnectAdmin)"
}

variable "deletion_protection" {
  type    = bool
  default = true
}

data "aws_region" "current" {}

# Encrypted at rest with the DSQL-managed key. A customer key in KMS only if a requirement asks.
resource "aws_dsql_cluster" "this" {
  deletion_protection_enabled = var.deletion_protection
  tags                        = { Name = var.name }
}

# The Lambda connects as `keepwell_app`, mapped to this IAM role by the migrator (AWS IAM GRANT).
# The pipeline's deploy role has dsql:DbConnectAdmin from the bootstrap, for migrations.
resource "aws_iam_role_policy" "connect" {
  name = "dsql-connect"
  role = var.app_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dsql:DbConnect"]
      Resource = aws_dsql_cluster.this.arn
    }]
  })
}

output "endpoint" {
  value = "${aws_dsql_cluster.this.identifier}.dsql.${data.aws_region.current.region}.on.aws"
}

output "arn" {
  value = aws_dsql_cluster.this.arn
}
