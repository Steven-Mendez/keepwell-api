# Rollback

Last rehearsed: not yet (before opening registration).

## Fast: point `live` back (seconds, code only)

Each deploy publishes a Lambda version and moves the `live` alias; `scripts/deploy-code.sh` prints
the previous version in the job log (`live 41 → 42 (rollback target: 41)`).

```bash
for fn in keepwell-$ENV-api keepwell-$ENV-jobs; do
  aws lambda list-versions-by-function --function-name $fn --query 'Versions[-3:].[Version,Description]'
done
aws lambda update-alias --function-name keepwell-$ENV-api --name live --function-version <previous>
aws lambda update-alias --function-name keepwell-$ENV-jobs --name live --function-version <previous>
./scripts/smoke.sh https://api.<domain> <previous commit sha>
```

Safe because migrations are additive: the previous code works against the newer schema.

## Complete: revert the commit (minutes, code and infrastructure)

```bash
git revert <bad sha> && git push   # through a pull request when there's time
```

The pipeline applies the previous infrastructure, migrates (nothing to undo: forward-only) and
publishes the previous code. A migration is never reverted; if a schema change itself is wrong, a
new migration fixes it forward.

## After

Leave `live` where it is until the revert reaches `main`: the next deploy moves it again.
