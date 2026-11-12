export class PersonEvents {
  constructor() { this.count = 0; this.pending = 0; this.hits = 0; this.emptySince = null; this.lastEvent = -Infinity; this.centers = []; }
  update(boxes, now = Date.now()) {
    const count = boxes.length;
    if (!count) {
      this.hits = 0; this.pending = 0;
      if (!this.count) return null;
      this.emptySince ??= now;
      if (now - this.emptySince < 3000) return null;
      this.count = 0; this.centers = []; this.lastEvent = now;
      return { kind: 'left', text: '人员已离开画面', count: 0, time: now };
    }
    this.emptySince = null;
    if (this.pending === count) this.hits++; else { this.pending = count; this.hits = 1; }
    const centers = boxes.map(b => [b.x + b.width / 2, b.y + b.height / 2]);
    if (count !== this.count && this.hits >= 2) {
      const kind = this.count ? 'count-changed' : 'entered'; this.count = count; this.centers = centers; this.lastEvent = now;
      return { kind, text: kind === 'entered' ? `检测到 ${count} 人出现` : `画面人数变化：${count} 人`, count, time: now };
    }
    if (count === this.count && now - this.lastEvent > 5000 && this.centers.length
      && centers.some(c => Math.min(...this.centers.map(p => Math.hypot(c[0] - p[0], c[1] - p[1]))) > .12)) {
      this.centers = centers; this.lastEvent = now;
      return { kind: 'moved', text: '检测到人员明显移动', count, time: now };
    }
    return null;
  }
}
