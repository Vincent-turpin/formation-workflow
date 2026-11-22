// Roue de la fortune en canvas. Le pointeur est en haut (12 h).
class Wheel {
  constructor(canvas, segments) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.segments = segments;
    this.angle = 0; // rotation courante (radians)
    this.spinning = false;
    this.draw();
  }

  draw() {
    const { ctx, c, segments } = this;
    const size = c.width, r = size / 2, n = segments.length, arc = (Math.PI * 2) / n;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(r, r);
    // anneau extérieur
    ctx.beginPath(); ctx.arc(0, 0, r - 2, 0, Math.PI * 2); ctx.fillStyle = '#110824'; ctx.fill();
    ctx.rotate(this.angle);
    for (let i = 0; i < n; i++) {
      const start = -Math.PI / 2 + i * arc;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 14, start, start + arc); ctx.closePath();
      ctx.fillStyle = segments[i].color; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 2; ctx.stroke();
      // texte
      ctx.save();
      ctx.rotate(start + arc / 2);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      const fs = Math.max(12, Math.min(26, size / (n * 2.6)));
      ctx.font = `600 ${fs}px 'Instrument Sans', system-ui, sans-serif`;
      this.wrap(segments[i].label, r - 30, fs);
      ctx.restore();
    }
    ctx.restore();
    // lumières
    ctx.save(); ctx.translate(r, r);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(Math.cos(a) * (r - 8), Math.sin(a) * (r - 8), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? '#D946EF' : '#F3EEFF'; ctx.fill();
    }
    // moyeu
    ctx.beginPath(); ctx.arc(0, 0, r * 0.13, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.09, 0, Math.PI * 2); ctx.fillStyle = '#110824'; ctx.fill();
    ctx.restore();
    // pointeur
    ctx.beginPath();
    ctx.moveTo(r - 18, 4); ctx.lineTo(r + 18, 4); ctx.lineTo(r, 42); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#110824'; ctx.lineWidth = 4; ctx.fill(); ctx.stroke();
  }

  wrap(text, x, fs) {
    const words = String(text).split(' ');
    const lines = []; let line = '';
    const max = this.c.width * 0.3;
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (this.ctx.measureText(t).width > max && line) { lines.push(line); line = w; } else line = t;
    }
    lines.push(line);
    const lh = fs * 1.05, top = -((lines.length - 1) * lh) / 2;
    lines.slice(0, 3).forEach((l, i) => this.ctx.fillText(l, x, top + i * lh));
  }

  idle() {
    const tick = () => { if (!this.spinning) { this.angle += 0.004; this.draw(); } this.raf = requestAnimationFrame(tick); };
    tick();
  }

  stopIdle() { cancelAnimationFrame(this.raf); }

  // Fait tourner la roue pour s'arrêter au centre (légèrement aléatoire) du segment `index`.
  spinTo(index, duration = 5200) {
    this.stopIdle();
    this.spinning = true;
    const n = this.segments.length, arc = (Math.PI * 2) / n;
    const jitter = (Math.random() - 0.5) * arc * 0.6;
    // le segment i est centré sur l'angle i*arc + arc/2 depuis le haut ; on veut l'amener à 0
    const targetMod = (Math.PI * 2 - (index * arc + arc / 2) + jitter) % (Math.PI * 2);
    const current = this.angle % (Math.PI * 2);
    let delta = targetMod - current; if (delta < 0) delta += Math.PI * 2;
    const total = delta + Math.PI * 2 * 7;
    const start = this.angle, t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    return new Promise((resolve) => {
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / duration);
        this.angle = start + total * ease(t);
        this.draw();
        if (t < 1) requestAnimationFrame(frame); else { this.spinning = false; resolve(); }
      };
      requestAnimationFrame(frame);
    });
  }
}
window.Wheel = Wheel;
