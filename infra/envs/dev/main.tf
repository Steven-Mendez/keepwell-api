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
