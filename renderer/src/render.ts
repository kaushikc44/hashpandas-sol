/**
 * Deterministic seed -> PNG.
 *
 * There is no real sprite atlas yet (CLAUDE.md's build order for `programs/`
 * never got as far as putting one in a program-owned account), so this
 * draws a simple, fully-procedural panda from vector shapes instead of
 * compositing real art. It is honestly a placeholder, not "fully on-chain
 * art" -- Solana has no free `eth_call`, so this rendering happens here,
 * client-side, and is only as trustworthy as the code doing it. Anyone can
 * re-run this against the same seed and get pixel-identical output, which
 * is the actual guarantee worth making.
 */

import * as pureimage from "pureimage";
import type { Bitmap } from "pureimage";
import { deriveTraits, type PandaTraits } from "./traits.ts";

const SIZE = 512;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r1, g1, b1] = [0, 0, 0];
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function rgbStr(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return `rgb(${r},${g},${b})`;
}

function drawEyes(ctx: pureimage.Context, traits: PandaTraits, cx: number, cy: number): void {
  const spacing = 60;
  const eyeY = cy - 20;
  ctx.fillStyle = "rgb(20,20,25)";
  for (const dx of [-spacing, spacing]) {
    ctx.beginPath();
    // eyeStyle picks the patch shape "under" the pupil, like a real panda's
    // eye patches -- style 0/1 round, 2/3 taller.
    const rx = traits.eyeStyle < 2 ? 28 : 22;
    const ry = traits.eyeStyle < 2 ? 28 : 40;
    ctx.arc(cx + dx, eyeY, Math.max(rx, ry) / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgb(250,250,250)";
  for (const dx of [-spacing, spacing]) {
    ctx.beginPath();
    ctx.arc(cx + dx, eyeY, 8, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawAccessory(ctx: pureimage.Context, traits: PandaTraits, cx: number, cy: number): void {
  if (traits.accessory === 0) return; // no accessory
  const top = cy - 130;
  if (traits.accessory === 1) {
    // party hat
    ctx.fillStyle = rgbStr((traits.bodyHue + 180) % 360, 0.7, 0.5);
    ctx.beginPath();
    ctx.moveTo(cx - 40, top + 40);
    ctx.lineTo(cx + 40, top + 40);
    ctx.lineTo(cx, top - 40);
    ctx.closePath();
    ctx.fill();
  } else if (traits.accessory === 2) {
    // bowtie
    ctx.fillStyle = rgbStr((traits.backgroundHue + 90) % 360, 0.8, 0.5);
    ctx.beginPath();
    ctx.moveTo(cx - 30, cy + 90);
    ctx.lineTo(cx, cy + 75);
    ctx.lineTo(cx - 30, cy + 60);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + 30, cy + 90);
    ctx.lineTo(cx, cy + 75);
    ctx.lineTo(cx + 30, cy + 60);
    ctx.closePath();
    ctx.fill();
  } else if (traits.accessory === 3) {
    // glasses
    ctx.fillStyle = "rgb(30,30,30)";
    ctx.fillRect(cx - 90, cy - 30, 60, 10);
    ctx.beginPath();
    ctx.arc(cx - 60, cy - 20, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 60, cy - 20, 30, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // scarf
    ctx.fillStyle = rgbStr((traits.bodyHue + 40) % 360, 0.6, 0.45);
    ctx.fillRect(cx - 90, cy + 70, 180, 30);
  }
}

/** Renders one panda's traits to a 512x512 RGBA bitmap. */
export function renderTraits(traits: PandaTraits): Bitmap {
  const img = pureimage.make(SIZE, SIZE);
  const ctx = img.getContext("2d");

  ctx.fillStyle = rgbStr(traits.backgroundHue, 0.55, 0.85);
  ctx.fillRect(0, 0, SIZE, SIZE);

  const cx = SIZE / 2;
  const cy = SIZE / 2 + (traits.pose === 2 ? 20 : 0);

  // body
  ctx.fillStyle = rgbStr(traits.bodyHue, 0.05, 0.95); // near-white, hue-tinted
  ctx.beginPath();
  ctx.arc(cx, cy + 60, 150, 0, Math.PI * 2);
  ctx.fill();

  // head
  ctx.beginPath();
  ctx.arc(cx, cy - 40, 130, 0, Math.PI * 2);
  ctx.fill();

  // ears
  ctx.fillStyle = "rgb(25,25,30)";
  for (const dx of [-95, 95]) {
    ctx.beginPath();
    ctx.arc(cx + dx, cy - 130, 38, 0, Math.PI * 2);
    ctx.fill();
  }

  drawEyes(ctx, traits, cx, cy - 40);

  // nose
  ctx.fillStyle = "rgb(25,25,30)";
  ctx.beginPath();
  ctx.arc(cx, cy + 10, 14, 0, Math.PI * 2);
  ctx.fill();

  // pattern: a deterministic scatter of dots on the body, count driven by
  // patternDensity, positions driven by the pose+density combination so two
  // pandas with the same density still usually look different.
  ctx.fillStyle = rgbStr((traits.bodyHue + 200) % 360, 0.3, 0.6);
  const dotCount = traits.patternDensity * 4;
  for (let i = 0; i < dotCount; i++) {
    const angle = (i / Math.max(dotCount, 1)) * Math.PI * 2 + traits.pose;
    const radius = 60 + (i % 3) * 20;
    const dx = cx + Math.cos(angle) * radius;
    const dy = cy + 60 + Math.sin(angle) * radius * 0.6;
    ctx.beginPath();
    ctx.arc(dx, dy, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  drawAccessory(ctx, traits, cx, cy - 40);

  return img;
}

/** Convenience: seed bytes straight to a rendered bitmap. */
export function renderSeed(seed: Uint8Array): Bitmap {
  return renderTraits(deriveTraits(seed));
}
