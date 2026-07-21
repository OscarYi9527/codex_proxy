import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  redactSecretText,
  scanTextSecrets,
  sensitiveArtifactKind
} from '../src/secret-scan.js'

const root = path.resolve(import.meta.dirname, '..')

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed with exit code ${result.status}`)
  }
  return String(result.stdout || '')
}

export function addedLinesFromUnifiedDiff(diff) {
  const lines = String(diff || '').split(/\r?\n/)
  const added = []
  let file = ''
  let newLine = 0
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const candidate = line.slice(4).trim()
      file = candidate === '/dev/null'
        ? ''
        : candidate.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@ ')) {
      const match = /\+(\d+)(?:,\d+)?/.exec(line)
      newLine = match ? Number(match[1]) : 0
      continue
    }
    if (!file || !newLine) continue
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push({ file, line: newLine, text: line.slice(1) })
      newLine += 1
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      newLine += 1
    }
  }
  return added
}

function pathFinding(file, kind) {
  const safeFile = redactSecretText(file)
  return {
    kind,
    source: `git:${safeFile}`,
    path: safeFile
  }
}

export function scanUnifiedDiff(diff, options = {}) {
  const findings = []
  const addedLines = addedLinesFromUnifiedDiff(diff)
  for (const added of addedLines) {
    const safeFile = redactSecretText(added.file)
    for (const item of scanTextSecrets(added.text, {
      source: `git:${safeFile}`,
      path: safeFile,
      maxFindings: options.maxFindings || 100
    })) {
      findings.push({
        ...item,
        line: added.line,
        column: item.column
      })
    }
  }

  let group = []
  const scanGroup = () => {
    if (group.length < 2) {
      group = []
      return
    }
    const text = group.map(item => item.text).join('\n')
    const safeFile = redactSecretText(group[0].file)
    for (const item of scanTextSecrets(text, {
      source: `git:${safeFile}`,
      path: safeFile,
      maxFindings: options.maxFindings || 100
    })) {
      findings.push({
        ...item,
        line: group[0].line + Math.max(0, Number(item.line || 1) - 1),
        column: item.column
      })
    }
    group = []
  }
  for (const added of addedLines) {
    const previous = group.at(-1)
    if (
      previous &&
      (previous.file !== added.file || previous.line + 1 !== added.line)
    ) {
      scanGroup()
    }
    group.push(added)
  }
  scanGroup()
  return deduplicate(findings)
}

function changedNames(args, cwd) {
  return git(args, { cwd })
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
}

function scanPaths(paths, cwd, options = {}) {
  const findings = []
  for (const relative of paths) {
    const artifactKind = sensitiveArtifactKind(relative)
    if (artifactKind) findings.push(pathFinding(relative, artifactKind))
    if (!options.readContents) continue
    const absolute = path.resolve(cwd, relative)
    if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`)) continue
    let stat
    try {
      stat = fs.statSync(absolute)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue
    let text
    try {
      text = fs.readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    findings.push(...scanTextSecrets(text, {
      source: `git:${redactSecretText(relative)}`,
      path: redactSecretText(relative),
      maxFindings: options.maxFindings || 100
    }))
  }
  return findings
}

function deduplicate(findings) {
  const seen = new Set()
  return findings.filter(item => {
    const key = `${item.kind}|${item.source}|${item.path}|${item.line || 0}|${item.column || 0}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function scanGitChanges(options = {}) {
  const cwd = path.resolve(options.cwd || root)
  const mode = options.mode || 'auto'
  const findings = []
  let inspectedChanges = 0

  if (mode === 'auto' || mode === 'staged') {
    const stagedDiff = git(
      ['diff', '--cached', '--no-ext-diff', '--unified=0', '--binary', '--'],
      { cwd }
    )
    const stagedNames = changedNames(
      ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--'],
      cwd
    )
    inspectedChanges += stagedNames.length
    findings.push(...scanPaths(stagedNames, cwd))
    findings.push(...scanUnifiedDiff(stagedDiff, options))
  }

  if (mode === 'auto' || mode === 'working') {
    const workingDiff = git(
      ['diff', '--no-ext-diff', '--unified=0', '--binary', '--'],
      { cwd }
    )
    const workingNames = changedNames(
      ['diff', '--name-only', '--diff-filter=ACMR', '--'],
      cwd
    )
    const untracked = changedNames(
      ['ls-files', '--others', '--exclude-standard', '--'],
      cwd
    )
    inspectedChanges += workingNames.length + untracked.length
    findings.push(...scanPaths(workingNames, cwd))
    findings.push(...scanUnifiedDiff(workingDiff, options))
    findings.push(...scanPaths(untracked, cwd, { ...options, readContents: true }))
  }

  if (mode === 'auto' && inspectedChanges === 0) {
    const committedDiff = git(
      ['show', '--format=', '--no-ext-diff', '--unified=0', '--binary', 'HEAD', '--'],
      { cwd }
    )
    const committedNames = changedNames(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=ACMR', 'HEAD', '--'],
      cwd
    )
    findings.push(...scanPaths(committedNames, cwd))
    findings.push(...scanUnifiedDiff(committedDiff, options))
    inspectedChanges += committedNames.length
  }

  return {
    version: 1,
    mode,
    inspectedChanges,
    findings: deduplicate(findings)
  }
}

export function formatSecretScanReport(report) {
  return JSON.stringify({
    version: report.version,
    mode: report.mode,
    inspectedChanges: report.inspectedChanges,
    findingCount: report.findings.length,
    findings: report.findings.map(item => ({
      kind: item.kind,
      source: item.source,
      path: item.path,
      ...(item.line ? { line: item.line } : {}),
      ...(item.column ? { column: item.column } : {})
    }))
  }, null, 2)
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
  : false

if (isMain) {
  try {
    const mode = process.argv.includes('--staged')
      ? 'staged'
      : process.argv.includes('--working')
        ? 'working'
        : 'auto'
    const report = scanGitChanges({ mode })
    process.stdout.write(`${formatSecretScanReport(report)}\n`)
    if (report.findings.length) process.exitCode = 1
  } catch (error) {
    process.stderr.write('[secret-scan] scan failed without exposing file contents\n')
    process.exitCode = 2
  }
}
