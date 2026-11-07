# Restore from AWS Backup

Last rehearsed: not yet (before opening registration; then once a quarter).

AWS Backup keeps a daily copy of the prod cluster for 35 days (`infra/modules/backup`). A restore
creates a **new** cluster; production is never overwritten in place.

## 1. Pick the recovery point

```bash
aws backup list-recovery-points-by-backup-vault --backup-vault-name keepwell-prod-vault \
  --query 'RecoveryPoints[].[RecoveryPointArn,CreationDate,Status]' --output table
```

## 2. Restore into a temporary cluster

```bash
aws backup start-restore-job \
  --recovery-point-arn <arn> \
  --iam-role-arn "$(terraform -chdir=infra/envs/prod output -raw backup_role_arn 2>/dev/null || echo arn:aws:iam::<account>:role/keepwell-prod-backup)" \
  --metadata '{}' --resource-type "Aurora DSQL"
aws backup describe-restore-job --restore-job-id <id>   # until COMPLETED; note CreatedResourceArn
```

## 3. Check it

```bash
HOST=<new cluster id>.dsql.us-east-1.on.aws
DB_HOST=$HOST pnpm reconcile                      # the log replays to the tables
psql "host=$HOST user=admin dbname=postgres sslmode=require" -c 'select count(*) from transactions'
```

The rehearsal passes when reconcile reports no discrepancies and the author's latest movements
before the recovery point are there.

## 4a. Rehearsal: delete the temporary cluster

```bash
aws dsql update-cluster --identifier <new id> --no-deletion-protection-enabled
aws dsql delete-cluster --identifier <new id>
```

## 4b. Real recovery: copy what was lost

Prefer copying the affected rows (by `user_id`, entity and id, guided by `change_log`) from the
restored cluster into production through a reviewed script, written as normal API writes so they
reach `change_log` and the devices. Switching production to the restored cluster loses every change
made after the recovery point and is a last resort: it means pointing `module.database` at an
imported cluster in a reviewed pull request.
