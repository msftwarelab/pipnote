export interface BlockLineRange {
  id: string
  startLine: number
  endLine: number
}

interface ReorderableSegment {
  blockId: string
  startLine: number
  endLine: number
}

function clampLine(value: number, maxExclusive: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value >= maxExclusive) return Math.max(0, maxExclusive - 1)
  return Math.floor(value)
}

function buildSegments(blocks: BlockLineRange[], totalLines: number): ReorderableSegment[] {
  if (blocks.length === 0 || totalLines <= 0) return []

  return blocks.map((block, index) => {
    const startLine = clampLine(block.startLine, totalLines)
    const nextStart = index < blocks.length - 1
      ? clampLine(blocks[index + 1].startLine, totalLines)
      : totalLines
    const endLine = Math.max(startLine, Math.min(totalLines - 1, nextStart - 1))
    return {
      blockId: block.id,
      startLine,
      endLine,
    }
  })
}

function reorderContentByIndexOrder(
  content: string,
  segments: ReorderableSegment[],
  orderedIndices: number[],
): string {
  const lines = content.split('\n')
  if (segments.length === 0) return content

  const prefixEnd = Math.max(0, Math.min(lines.length, segments[0].startLine))
  const rebuiltLines: string[] = [...lines.slice(0, prefixEnd)]

  orderedIndices.forEach((segmentIndex) => {
    const segment = segments[segmentIndex]
    rebuiltLines.push(...lines.slice(segment.startLine, segment.endLine + 1))
  })

  return rebuiltLines.join('\n')
}

export function moveBlockInContent(
  content: string,
  blocks: BlockLineRange[],
  blockId: string,
  direction: -1 | 1,
): { content: string; moved: boolean } {
  if (blocks.length <= 1) return { content, moved: false }

  const lines = content.split('\n')
  const segments = buildSegments(blocks, lines.length)
  if (segments.length <= 1) return { content, moved: false }

  const currentIndex = segments.findIndex((segment) => segment.blockId === blockId)
  if (currentIndex === -1) return { content, moved: false }
  const targetIndex = currentIndex + direction
  if (targetIndex < 0 || targetIndex >= segments.length) return { content, moved: false }

  const order = segments.map((_, index) => index)
  ;[order[currentIndex], order[targetIndex]] = [order[targetIndex], order[currentIndex]]
  const nextContent = reorderContentByIndexOrder(content, segments, order)
  return {
    content: nextContent,
    moved: nextContent !== content,
  }
}

export function duplicateBlockInContent(
  content: string,
  blocks: BlockLineRange[],
  blockId: string,
): { content: string; duplicated: boolean } {
  if (blocks.length === 0) return { content, duplicated: false }

  const lines = content.split('\n')
  const segments = buildSegments(blocks, lines.length)
  if (segments.length === 0) return { content, duplicated: false }

  const currentIndex = segments.findIndex((segment) => segment.blockId === blockId)
  if (currentIndex === -1) return { content, duplicated: false }

  const order = segments.map((_, index) => index)
  order.splice(currentIndex + 1, 0, currentIndex)
  const nextContent = reorderContentByIndexOrder(content, segments, order)
  return {
    content: nextContent,
    duplicated: nextContent !== content,
  }
}
