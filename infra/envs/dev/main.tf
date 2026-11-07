terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {
    key          = "dev/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "keepwell", environment = "dev", managed_by = "terraform" }
  }
}

# Same definition as prod. dev holds test data only, so its cluster can be destroyed.
module "environment" {
  source              = "../../modules/environment"
  environment         = "dev"
  domain              = var.domain
  hostname            = "api.dev.${var.domain}"
  web_hostname        = "app.dev.${var.domain}"
  lambda_zip          = var.lambda_zip
  jobs_zip            = var.jobs_zip
  alert_email         = var.alert_email
  app_version         = var.app_version
  deletion_protection = false
}
