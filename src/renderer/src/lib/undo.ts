/**
 * Tiny undo stack. We snapshot the editable transcript text on every "destructive"
 * action (rewrite, file load, file replace). Plain text only — no rich-text diffs.
 */

export class UndoStack<T> {
  private stack: T[] = []
  private limit: number

  constructor(limit = 50) {
    this.limit = limit
  }

  push(value: T): void {
    this.stack.push(value)
    if (this.stack.length > this.limit) this.stack.shift()
  }

  pop(): T | undefined {
    return this.stack.pop()
  }

  peek(): T | undefined {
    return this.stack[this.stack.length - 1]
  }

  size(): number {
    return this.stack.length
  }

  clear(): void {
    this.stack = []
  }
}
