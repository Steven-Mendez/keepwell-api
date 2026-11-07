# Increments 1 and 2 declared these modules at the root; increment 3 groups them per environment.
# Without these blocks the plan would destroy and recreate the live API and its domain.
moved {
  from = module.api
  to   = module.environment.module.api
}

moved {
  from = module.dns
  to   = module.environment.module.dns
}
