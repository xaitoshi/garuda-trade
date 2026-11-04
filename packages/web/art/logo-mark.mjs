// Generates public/logo-mark.svg: node packages/web/art/logo-mark.mjs packages/web/public/logo-mark.svg
import fs from 'node:fs';
const out = process.argv[2], f = (n) => +n.toFixed(2);
// Feathers: dotted rays fanning out from each shoulder, longest near horizontal, shorter as they rise.
const feathers = [ { a: 12, n: 6 }, { a: 30, n: 6 }, { a: 48, n: 5 }, { a: 66, n: 4 } ];
let dots = '';
for (const s of [-1, 1]) feathers.forEach((fe, fi) => {
  const ox = 60 + s * 9, oy = 60, rad = (fe.a + 0) * Math.PI / 180;
  for (let i = 0; i < fe.n; i++) {
    const d = 13 + i * 7.6;
    const x = ox + s * Math.cos(rad) * d, y = oy - Math.sin(rad) * d * 0.95 + (i * i) * 0.12;
    const r = 2.9 - i * 0.3;
    const delay = Math.round(fi * 110 + i * 70);
    dots += `<circle class="d" style="animation-delay:${delay}ms" cx="${f(x)}" cy="${f(y)}" r="${f(r)}"/>`;
  }
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 14 128 74" role="img" aria-label="Garuda">
<style>
.d{fill:#f4f4f5;opacity:.3;transform-box:fill-box;transform-origin:center;animation:flap 2.6s cubic-bezier(.22,.7,.24,1) infinite}
@keyframes flap{0%,46%,100%{opacity:.3;transform:scale(1)}20%{opacity:1;transform:scale(1.25)}}
.head{fill:#f4f4f5}
.visor{fill:#000;transform-box:fill-box;transform-origin:center;animation:look 5.2s cubic-bezier(.22,.7,.24,1) infinite}
@keyframes look{0%,100%{transform:translateX(0)}30%{transform:translateX(-1.4px)}62%{transform:translateX(1.4px)}}
@media (prefers-reduced-motion:reduce){.d,.visor{animation:none}.d{opacity:.75}}
</style>
${dots}
<path class="head" d="M60 30 L70 56 Q66 70 60 86 Q54 70 50 56 Z"/>
<g class="visor"><rect x="53" y="53" width="6" height="3.6" rx="1.8"/><rect x="61" y="53" width="6" height="3.6" rx="1.8"/></g>
</svg>`;
fs.writeFileSync(out, svg);
