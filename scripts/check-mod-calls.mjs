// shim/scripts/check-mod-calls.mjs -- spec 095 D3, task A7.
// Asks Claude Code what the mod hooks and calls, and fails when the answer is
// not the list the spec allows. src/mod.test.mjs reads the source as text;
// this reads what Claude Code itself finds, which is the list a person sees
// with `claude plugin validate` before installing.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const CALLS = [
  '$.command.register',
  '$.mcp.call',
  '$.mcp.connect',
  '$.prompt.fill',
  '$.session.cwd',
  '$.store.get',
  '$.store.set',
  '$.ui.invalidate',
  '$.ui.open',
  '$.ui.resolve',
]
export const EVENTS = ['command.run', 'session.measure', 'session.start', 'ui.render']

/** The names on one `hooks:` or `calls:` line, without matchers and notes. */
export function namesOn(output, label) {
  const line = output.split('\n').find((row) => row.includes(`waku-mod.mjs ${label}:`))
  if (line === undefined) {
    return undefined
  }
  const names = line
    .slice(line.indexOf(`${label}:`) + label.length + 1)
    .replace(/\([^)]*\)/g, '')
    .replace(/\{[^}]*\}/g, '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)

  return [...new Set(names)].sort()
}

function main() {
  let output
  try {
    output = execFileSync('claude', ['plugin', 'validate', root], { encoding: 'utf8' })
  } catch (failure) {
    console.error(String(failure.stdout ?? failure.message))
    console.error('claude plugin validate did not pass.')
    process.exit(1)
  }
  const problems = []
  for (const [label, want] of [['calls', CALLS], ['hooks', EVENTS]]) {
    const got = namesOn(output, label)
    if (got === undefined) {
      problems.push(`claude plugin validate printed no "${label}:" line for waku-mod.mjs.`)
    } else if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(`The mod's ${label} are ${got.join(', ')}. Spec 095 D3 allows ${want.join(', ')}.`)
    }
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('The mod hooks and calls what spec 095 D3 allows.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
