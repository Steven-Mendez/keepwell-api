# Runbooks

Step-by-step procedures for the moments that leave no time to think. Each one was rehearsed once
before registration opened (PLAN_API.md, section 5, checklist item 10); the date of the last
rehearsal is at the top of each file.

| Runbook | When |
| --- | --- |
| [incident.md](incident.md) | Something is wrong in production and you don't know yet what |
| [rollback.md](rollback.md) | A deploy broke something; go back to the previous version |
| [restore.md](restore.md) | Data was lost or corrupted; restore from AWS Backup |
| [secret-rotation.md](secret-rotation.md) | A secret leaked, or it's time to rotate |

Every command assumes `export AWS_REGION=us-east-1 ENV=prod` and an administrator profile.
