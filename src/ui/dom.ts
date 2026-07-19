// Типобезопасные DOM-хелперы (as-касты в проекте запрещены).
// По образцу ../formula-synth (src/ui/dom.ts).
export function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`нет элемента #${id}`);
  return e;
}

export function inputEl(id: string): HTMLInputElement {
  const e = el(id);
  if (!(e instanceof HTMLInputElement)) throw new Error(`#${id} — не <input>`);
  return e;
}

export function buttonEl(id: string): HTMLButtonElement {
  const e = el(id);
  if (!(e instanceof HTMLButtonElement)) throw new Error(`#${id} — не <button>`);
  return e;
}

export function svgRootEl(id: string): SVGSVGElement {
  const e = document.getElementById(id);
  if (!(e instanceof SVGSVGElement)) throw new Error(`#${id} — не <svg>`);
  return e;
}
