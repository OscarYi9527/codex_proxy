import type { ProviderDiagnostics } from '../../app/types'

export function DiagnosticsPage({
  diagnostics
}: {
  readonly diagnostics: ProviderDiagnostics
}) {
  return (
    <section className="content-card" aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title">系统诊断</h2>
      <p className="muted">仅一级管理员可见。所有内容均经过服务端脱敏。</p>
      <pre className="diagnostics-output">
        {JSON.stringify(diagnostics, null, 2)}
      </pre>
    </section>
  )
}
