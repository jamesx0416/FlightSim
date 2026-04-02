export interface XmlTextNode {
  type: 'text'
  text: string
}

export interface XmlElementNode {
  type: 'element'
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
}

export type XmlNode = XmlTextNode | XmlElementNode

export function parseXmlDocument(source: string): XmlElementNode {
  const root: XmlElementNode = {
    type: 'element',
    name: '#document',
    attributes: {},
    children: []
  }
  const stack: XmlElementNode[] = [root]
  const tokenPattern =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[^>]+>/g
  let lastIndex = 0

  for (const match of source.matchAll(tokenPattern)) {
    const rawToken = match[0]
    const tokenIndex = match.index ?? 0
    const textChunk = source.slice(lastIndex, tokenIndex)
    appendTextNode(stack.at(-1)!, textChunk)
    lastIndex = tokenIndex + rawToken.length

    if (rawToken.startsWith('<!--') || rawToken.startsWith('<?') || rawToken.startsWith('<!DOCTYPE')) {
      continue
    }

    if (rawToken.startsWith('<![CDATA[')) {
      appendTextNode(stack.at(-1)!, rawToken.slice(9, -3))
      continue
    }

    if (rawToken.startsWith('</')) {
      if (stack.length > 1) {
        stack.pop()
      }
      continue
    }

    const selfClosing = rawToken.endsWith('/>')
    const tagBody = rawToken.slice(1, selfClosing ? -2 : -1).trim()
    const tagNameMatch = tagBody.match(/^([^\s/>]+)/)
    if (!tagNameMatch) continue

    const element: XmlElementNode = {
      type: 'element',
      name: tagNameMatch[1],
      attributes: parseAttributes(tagBody.slice(tagNameMatch[0].length)),
      children: []
    }

    stack.at(-1)!.children.push(element)
    if (!selfClosing) {
      stack.push(element)
    }
  }

  appendTextNode(stack.at(-1)!, source.slice(lastIndex))
  return root
}

export function getElementChildren(node: XmlElementNode): XmlElementNode[] {
  return node.children.filter((child): child is XmlElementNode => child.type === 'element')
}

export function getTextContent(node: XmlElementNode): string {
  return node.children
    .map((child) => {
      if (child.type === 'text') return child.text
      return getTextContent(child)
    })
    .join('')
}

function appendTextNode(parent: XmlElementNode, text: string): void {
  const decoded = decodeXmlEntities(text)
  if (!decoded || decoded.trim().length === 0) return
  parent.children.push({ type: 'text', text: decoded })
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(/([A-Za-z0-9_:#.-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? '')
  }
  return attributes
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
