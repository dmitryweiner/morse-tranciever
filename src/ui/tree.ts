// The dichotomic Morse tree, drawn like the brass training card: dash goes
// left, dot goes right; dash nodes are rounded bars, dot nodes are circles.
// While a symbol is keyed/received, the path from the root lights up and the
// tip node glows; a committed letter flashes its node.

import { decodeCode, MAX_CODE_LENGTH } from '../morse/code';

const NS = 'http://www.w3.org/2000/svg';
const W = 720;
const H = 470;
const TOP = 44;
const DY = 100;
// Horizontal spread of a child at depth 1..4.
const DX = [176, 88, 44, 22];

// Размеры узлов. Мобильный вариант: буквы вдвое крупнее (font — в CSS,
// media query), узлы больше, а нижний ряд — в шахматном порядке (stagger),
// иначе при том же размере диаграммы 16 листьев не помещаются.
export interface TreeLayout {
  dotR: number;
  dashW: number;
  dashH: number;
  stagger: number;
}

export const DESKTOP_LAYOUT: TreeLayout = { dotR: 15, dashW: 38, dashH: 24, stagger: 0 };
export const MOBILE_LAYOUT: TreeLayout = { dotR: 24, dashW: 54, dashH: 36, stagger: 32 };

// Мини-легенда в верхних углах: точка — влево от узла нельзя догадаться,
// поэтому подписываем цвет/форму (круг = dot, брусок = dash).
function buildLegend(): SVGGElement {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'legend');

  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', '26');
  dot.setAttribute('cy', String(TOP - 14));
  dot.setAttribute('r', '9');
  const dotLabel = document.createElementNS(NS, 'text');
  dotLabel.setAttribute('x', '42');
  dotLabel.setAttribute('y', String(TOP - 13));
  dotLabel.textContent = 'dot';

  const dash = document.createElementNS(NS, 'rect');
  dash.setAttribute('x', String(W - 96));
  dash.setAttribute('y', String(TOP - 22));
  dash.setAttribute('width', '26');
  dash.setAttribute('height', '16');
  dash.setAttribute('rx', '4');
  const dashLabel = document.createElementNS(NS, 'text');
  dashLabel.setAttribute('x', String(W - 62));
  dashLabel.setAttribute('y', String(TOP - 13));
  dashLabel.textContent = 'dash';

  g.append(dot, dotLabel, dash, dashLabel);
  return g;
}

export class TreeView {
  private nodeByCode = new Map<string, SVGGElement>();
  private linkByCode = new Map<string, SVGLineElement>();
  private lit: string[] = [];
  private flashTimers = new Map<string, number>();

  constructor(svg: SVGSVGElement, private layout: TreeLayout = DESKTOP_LAYOUT) {
    svg.setAttribute('viewBox', `0 0 ${W} ${H + layout.stagger}`);
    const links = document.createElementNS(NS, 'g');
    const nodes = document.createElementNS(NS, 'g');
    svg.append(links, nodes, buildLegend());
    nodes.append(this.buildRoot(W / 2, TOP));
    this.buildChildren('', W / 2, TOP, links, nodes);
  }

  // Light the path from the root to the node of `code` ('' clears).
  setPath(code: string): void {
    for (const lit of this.lit) {
      this.nodeByCode.get(lit)?.classList.remove('on', 'cur');
      this.linkByCode.get(lit)?.classList.remove('on');
    }
    this.lit = [];
    const root = this.nodeByCode.get('');
    root?.classList.toggle('on', code.length > 0);
    if (code.length > 0) this.lit.push('');
    for (let i = 1; i <= Math.min(code.length, MAX_CODE_LENGTH); i++) {
      const prefix = code.slice(0, i);
      const node = this.nodeByCode.get(prefix);
      if (!node) break;
      node.classList.add('on');
      if (i === code.length) node.classList.add('cur');
      this.linkByCode.get(prefix)?.classList.add('on');
      this.lit.push(prefix);
    }
  }

  // Brief pulse on the node of a committed letter.
  flash(code: string): void {
    const node = this.nodeByCode.get(code);
    if (!node) return;
    const pending = this.flashTimers.get(code);
    if (pending !== undefined) window.clearTimeout(pending);
    node.classList.remove('hit');
    // Перезапуск CSS-анимации требует reflow между remove/add.
    void node.getBoundingClientRect();
    node.classList.add('hit');
    this.flashTimers.set(code, window.setTimeout(() => {
      node.classList.remove('hit');
      this.flashTimers.delete(code);
    }, 500));
  }

  private buildRoot(x: number, y: number): SVGGElement {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'node root');
    g.setAttribute('transform', `translate(${x} ${y})`);
    const mast = document.createElementNS(NS, 'path');
    mast.setAttribute('d', 'M0 14 L0 -8 M-11 -16 L0 -8 L11 -16 M-11 -16 L11 -16');
    mast.setAttribute('class', 'antenna');
    g.append(mast);
    this.nodeByCode.set('', g);
    return g;
  }

  private buildChildren(
    code: string, x: number, y: number, links: SVGGElement, nodes: SVGGElement,
  ): void {
    const depth = code.length;
    if (depth >= MAX_CODE_LENGTH) return;
    // Как на карточке: тире — влево, точка — вправо.
    const children: Array<['-' | '.', number]> = [
      ['-', x - DX[depth]],
      ['.', x + DX[depth]],
    ];
    for (const [element, cx] of children) {
      const childCode = code + element;
      // Листья (глубина 4) при stagger чередуют высоту по чётности позиции.
      let cy = y + DY;
      if (childCode.length === MAX_CODE_LENGTH && this.layout.stagger) {
        const slot = Math.round(((cx - W / 2) / DX[3] - 1) / 2);
        cy += (((slot % 2) + 2) % 2 === 0 ? -1 : 1) * this.layout.stagger;
      }
      const link = document.createElementNS(NS, 'line');
      link.setAttribute('x1', String(x));
      link.setAttribute('y1', String(y));
      link.setAttribute('x2', String(cx));
      link.setAttribute('y2', String(cy));
      link.setAttribute('class', 'tlink');
      links.append(link);
      this.linkByCode.set(childCode, link);
      nodes.append(this.buildNode(childCode, cx, cy));
      this.buildChildren(childCode, cx, cy, links, nodes);
    }
  }

  private buildNode(code: string, x: number, y: number): SVGGElement {
    const char = decodeCode(code);
    const isDash = code.endsWith('-');
    const { dotR, dashW, dashH } = this.layout;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(${x} ${y})`);
    g.setAttribute('class', `node ${isDash ? 'dash' : 'dot'}${char ? '' : ' ghost'}`);
    g.dataset.code = code;
    if (isDash) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(-dashW / 2));
      rect.setAttribute('y', String(-dashH / 2));
      rect.setAttribute('width', String(dashW));
      rect.setAttribute('height', String(dashH));
      rect.setAttribute('rx', '5');
      g.append(rect);
    } else {
      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('r', String(dotR));
      g.append(circle);
    }
    if (char) {
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('y', '1');
      label.textContent = char;
      g.append(label);
    }
    this.nodeByCode.set(code, g);
    return g;
  }
}
