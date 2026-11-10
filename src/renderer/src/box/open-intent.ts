export class LatestOpenIntent {
  private generation = 0

  begin(): number {
    return ++this.generation
  }

  cancel(): void {
    this.generation++
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}
