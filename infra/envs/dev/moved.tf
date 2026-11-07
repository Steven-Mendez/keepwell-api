# Increment 5 turned the single auth_secret parameter into a set.
moved {
  from = module.environment.module.parameters.aws_ssm_parameter.auth_secret
  to   = module.environment.module.parameters.aws_ssm_parameter.manual["auth_secret"]
}
