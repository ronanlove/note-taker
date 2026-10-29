/** What finger gestures do to the page. Positions are in CSS pixels from the page's top-left corner. */
export interface View {
  pan(dx: number, dy: number): void;
  zoom(factor: number, x: number, y: number): void;
  tap(fingers: number): void;
}

interface Finger {
  x: number;
  y: number;
  x0: number;
  y0: number;
}

/** Fingers move this far, in CSS pixels, before the page starts to scroll. Keeps a resting hand from nudging it. */
const SLOP = 10;
const TAP_TIME = 300;
/** A touch landing this soon after the pen lifts is most likely the writing hand. */
const PALM_TIME = 250;
/** How quickly a flicked page slows down, in ms. About what iOS uses. */
const GLIDE = 325;

/**
 * One finger scrolls, with momentum. Two pinch to zoom. A quick tap with two or three fingers undoes or redoes.
 * Fingers resting on the screen while the pen writes are a palm, and are ignored until they lift.
 */
export class TouchGestures {
  private fingers = new Map<number, Finger>();
  private palms = new Set<number>();
  private most = 0;
  private began = 0;
  private moved = false;
  private velocity = [0, 0];
  private time = 0;
  private frame = 0;
  private pen = false;
  private penLifted = -Infinity;

  constructor(private view: View) {}

  get active() {
    return this.fingers.size > 0;
  }

  /** The pen went down: anything touching the screen now is the hand holding it. */
  penDown() {
    this.pen = true;
    this.stop();
    for (const id of this.fingers.keys()) this.palms.add(id);
    this.fingers.clear();
  }

  penUp(time: number) {
    this.pen = false;
    this.penLifted = time;
  }

  down(e: PointerEvent, x: number, y: number) {
    this.stop();
    if (this.pen || e.timeStamp - this.penLifted < PALM_TIME) return void this.palms.add(e.pointerId);
    if (!this.fingers.size) {
      this.most = 0;
      this.began = e.timeStamp;
      this.moved = false;
    }
    this.fingers.set(e.pointerId, { x, y, x0: x, y0: y });
    this.most = Math.max(this.most, this.fingers.size);
    this.velocity = [0, 0];
    this.time = e.timeStamp;
  }

  move(e: PointerEvent, x: number, y: number) {
    const finger = this.fingers.get(e.pointerId);
    if (!finger) return;
    const [ax, ay, aSpread] = this.centroid();
    finger.x = x;
    finger.y = y;
    const [bx, by, bSpread] = this.centroid();
    this.moved ||= Math.hypot(x - finger.x0, y - finger.y0) > SLOP;
    if (!this.moved) return;
    // Zoom about where the fingers were, then follow them.
    if (aSpread && bSpread) this.view.zoom(bSpread / aSpread, ax, ay);
    this.view.pan(bx - ax, by - ay);
    const dt = e.timeStamp - this.time;
    this.time = e.timeStamp;
    if (this.fingers.size === 1 && dt > 0) {
      this.velocity = [0.8 * ((bx - ax) / dt) + 0.2 * this.velocity[0], 0.8 * ((by - ay) / dt) + 0.2 * this.velocity[1]];
    }
  }

  up(e: PointerEvent) {
    if (this.palms.delete(e.pointerId) || !this.fingers.delete(e.pointerId)) return;
    if (this.fingers.size) return void (this.velocity = [0, 0]);
    if (e.type !== 'pointerup') return;
    if (this.most > 1 && !this.moved && e.timeStamp - this.began < TAP_TIME) this.view.tap(this.most);
    else if (this.most === 1 && e.timeStamp - this.time < 60) this.glide();
  }

  /** Stops a flicked page. */
  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private glide() {
    let [vx, vy] = this.velocity;
    if (Math.hypot(vx, vy) < 0.2) return;
    let last = performance.now();
    const step = (now: number) => {
      const decay = Math.exp(-(now - last) / GLIDE);
      last = now;
      this.view.pan(vx * GLIDE * (1 - decay), vy * GLIDE * (1 - decay));
      vx *= decay;
      vy *= decay;
      this.frame = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    this.frame = requestAnimationFrame(step);
  }

  /** Middle of the fingers, and their average distance from it. */
  private centroid(): [x: number, y: number, spread: number] {
    const all = [...this.fingers.values()];
    const x = all.reduce((sum, f) => sum + f.x, 0) / all.length;
    const y = all.reduce((sum, f) => sum + f.y, 0) / all.length;
    const spread = all.reduce((sum, f) => sum + Math.hypot(f.x - x, f.y - y), 0) / all.length;
    return [x, y, spread];
  }
}
