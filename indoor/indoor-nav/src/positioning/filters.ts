/** Second-order IIR sections (RBJ audio-EQ cookbook), direct form I. */
export class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  static lowpass(fc: number, fs: number, q = Math.SQRT1_2): Biquad {
    const f = new Biquad()
    const w = (2 * Math.PI * fc) / fs
    const c = Math.cos(w)
    const alpha = Math.sin(w) / (2 * q)
    const a0 = 1 + alpha
    f.b0 = (1 - c) / 2 / a0
    f.b1 = (1 - c) / a0
    f.b2 = f.b0
    f.a1 = (-2 * c) / a0
    f.a2 = (1 - alpha) / a0
    return f
  }

  static highpass(fc: number, fs: number, q = Math.SQRT1_2): Biquad {
    const f = new Biquad()
    const w = (2 * Math.PI * fc) / fs
    const c = Math.cos(w)
    const alpha = Math.sin(w) / (2 * q)
    const a0 = 1 + alpha
    f.b0 = (1 + c) / 2 / a0
    f.b1 = -(1 + c) / a0
    f.b2 = f.b0
    f.a1 = (-2 * c) / a0
    f.a2 = (1 - alpha) / a0
    return f
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}
