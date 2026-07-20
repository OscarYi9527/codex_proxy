# AI Editor Public MVP Capacity Gate — T139 Handoff

Date: 2026-07-21

## Delivery

- Repository: `OscarYi9527/codex_proxy`
- Branch: `codex/provider-worker-mvp`
- Capacity implementation: `6e73100`
- Isolated-login cleanup fix found by the release gate: `131467b`

## Frozen capacity semantics

The temporary public-MVP architecture admits at most **30 product accounts in
total**:

- the bootstrap Level-1 administrator counts;
- additional Level-1 and Level-2 administrators count;
- ordinary users count;
- disabling an admitted account does not silently free a slot;
- there is no environment-variable or management-API bypass.

Account 31 remains blocked until the long-term HA core is implemented and
accepted. A future unlock must be an explicit, audited production gate rather
than a casual runtime setting.

## Implementation

Migration `004_public_mvp_capacity` creates one deployment-capacity row and
initializes its admitted count from every existing account. Fresh bootstrap
reserves the first slot.

Invitation registration performs these operations in one database transaction:

1. validate the email and invitation;
2. atomically reserve a deployment-capacity slot with a conditional `UPDATE`;
3. atomically consume one invitation use;
4. insert the account, password credential and authorization code.

Concurrent final registrations therefore cannot both create account 30/31.
Rollback restores both the capacity reservation and invitation use. Rejected
registrations return:

```json
{
  "error": {
    "code": "public_mvp_capacity_reached",
    "retryable": false
  }
}
```

with HTTP `409`.

At capacity, the server also stops issuing new invitations. Level 1 can inspect
the read-only gate through `GET /api/v1/admin/capacity`. The dedicated
management page displays admitted/limit/remaining counts and disables the
invitation button at 30. Level 2 cannot read deployment-capacity details.

## Additional release-gate fix

The first T139 release-check rerun exposed a pre-existing Windows lifecycle
race in official ChatGPT account login:

- invalid, cancelled and timeout paths marked the login complete before the
  isolated Codex app-server process exited;
- the child could keep a handle to its temporary `CODEX_HOME`;
- cleanup then intermittently failed with Windows `EPERM`.

All terminal paths now wait for the owned child process (and its Windows process
tree fallback) before deleting the isolated login directory. Cleanup retries are
bounded, and failure is surfaced as a safe error instead of being silently
ignored. The lifecycle test passed five consecutive focused runs before the
complete release gate.

## Automated validation

- Proxy/Edge/Worker root tests: `166/166`
- Gateway tests: `136/136`
- Admin Web tests: `31/31`
- SQLite migration, bootstrap counting, concurrent final registration,
  transaction rollback and Level-1-only capacity tests: passed
- SQLite/PostgreSQL repository contract: passed
- isolated login lifecycle focused repeat: `5/5`
- `npm run release:check`: passed
- Provider Worker release boundary: `29` files
- Gateway and Admin production builds: passed

The first release-check attempt was blocked by the already-running isolated
Edge on `47921`. The Edge was stopped with the repository ownership-aware
script; shared `47892` was not touched. A subsequent release-check exposed the
login cleanup race above. After fixing that race, the complete release gate
passed.

## Deployment state

Automated local validation is complete. VMware deployment is deferred because
the guest SSH service does not currently accept the Windows development key and
the human operator is offline. Do not weaken SSH authentication or place a
password in a script to bypass this gate.

The existing public Quick Tunnel remains a preview-only endpoint and continues
to serve the prior VMware build until an authorized guest deployment is
performed.

## Remaining human-gated work

- T136b: select production KMS/Secret Manager, PostgreSQL and off-host backup.
- T137: purchase/approve and deploy the domestic Gateway and authorized-region
  Worker.
- T138: complete the 72-hour, three-network and long-connection acceptance.
- Authorize the Windows SSH key in the VMware guest, then pull this branch and
  rebuild the preview stack.
