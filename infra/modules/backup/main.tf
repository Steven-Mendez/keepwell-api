terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "retention_days" {
  type    = number
  default = 35
}

variable "alarm_topic_arn" {
  type = string
}

# Daily copies of the prod cluster, kept 35 days: the window the privacy policy and the deletion
# screen promise. Restoring creates a new cluster (docs/runbooks/restore.md); nothing restores in place.
resource "aws_backup_vault" "this" {
  name = "${var.name}-vault"
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_backup_plan" "daily" {
  name = "${var.name}-daily"
  rule {
    rule_name         = "daily-35-days"
    target_vault_name = aws_backup_vault.this.name
    schedule          = "cron(0 8 * * ? *)" # 02:00 in Managua
    start_window      = 60
    completion_window = 180
    lifecycle {
      delete_after = var.retention_days
    }
  }
}

data "aws_iam_policy_document" "backup_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_trust.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_selection" "cluster" {
  name         = "${var.name}-cluster"
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [var.cluster_arn]
}

# A failed backup job is worth a page: the restore drill depends on these copies.
resource "aws_backup_vault_notifications" "failures" {
  backup_vault_name   = aws_backup_vault.this.name
  sns_topic_arn       = var.alarm_topic_arn
  backup_vault_events = ["BACKUP_JOB_FAILED", "RESTORE_JOB_COMPLETED", "RESTORE_JOB_FAILED"]
}

output "vault_name" {
  value = aws_backup_vault.this.name
}

output "role_arn" {
  value = aws_iam_role.backup.arn
}
