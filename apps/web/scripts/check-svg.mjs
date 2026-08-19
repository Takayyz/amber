// Fails if any SVG under public/ is not well-formed XML.
//
// An SVG that does not parse is served with a 200 and the right content-type,
// and simply never renders -- the tab keeps whatever icon it had, so the only
// symptom is "my change did nothing". A double hyphen inside a comment is the
// easy way to cause it, and this repo's comment style reaches for one often.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

// Enough to catch the malformed cases; a full XML parser is not worth a
// dependency here. Each rule is something that makes a browser drop the file.
const RULES = [
  [/<!--[\s\S]*?--[\s\S]*?-->/, 'comment contains a double hyphen (invalid in XML)'],
  [/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/, 'bare ampersand'],
]

function unclosedTags(source) {
  const stack = []
  const tag = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g
  let match
  while ((match = tag.exec(source))) {
    const [, closing, name, attrs, selfClosing] = match
    if (selfClosing || attrs.endsWith('/')) continue
    if (closing) {
      if (stack.pop() !== name) return `mismatched </${name}>`
    } else {
      stack.push(name)
    }
  }
  return stack.length > 0 ? `unclosed <${stack.at(-1)}>` : null
}

const problems = []
for (const name of readdirSync(PUBLIC_DIR)) {
  if (!name.endsWith('.svg')) continue
  const source = readFileSync(join(PUBLIC_DIR, name), 'utf8')

  // Comments can legitimately hold anything else, so they are removed before
  // the remaining rules run.
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '')

  for (const [pattern, why] of RULES) {
    const target = why.startsWith('comment') ? source : withoutComments
    if (pattern.test(target)) problems.push(`${name}: ${why}`)
  }
  const unclosed = unclosedTags(withoutComments)
  if (unclosed) problems.push(`${name}: ${unclosed}`)
}

if (problems.length > 0) {
  console.error('malformed SVG:')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`ok: every SVG in public/ parses`)
