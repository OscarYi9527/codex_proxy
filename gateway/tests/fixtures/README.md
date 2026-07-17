# Vendored AI Editor contract fixture

`edge-code-contract.json` mirrors:

```text
My_Code@dca68160b25cee78b2c231c4fbd8398624ab93ff/
specs/002-ai-editor-account-gateway/contracts/fixtures/edge-code-contract.json
```

Gateway and Edge contract tests consume this checked-in copy so CI does not depend on a sibling
checkout or network access. Contract changes must update the My_Code source first, then refresh this
file and its source commit in the same reviewed codex_proxy change.
