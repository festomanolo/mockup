// Slide templates as pure layout data: where the headline and the device(s) go, in slide-relative units.
// Resolution independent, so the same layout drives the small preview and the full-size export. A device
// may sit outside the slide (x beyond 0..W) so it straddles into the neighbouring slide of the panorama.
import type { TemplateId } from "./model";

export type DevPlace = {
  /** Horizontal centre in px, relative to the slide's left edge. */
  x: number;
  /** Top edge in px. */
  top: number;
  /** Width in px; height follows the device's aspect ratio. */
  w: number;
  /** Rotation in radians. */
  rot: number;
  /** Added to the slide's screenshot index so a second device can show a different screen. */
  shotOffset: number;
};
export type TextPlace = { x: number; y: number; w: number; align: "left" | "center" | "right"; scale: number; maxLines: number };
export type Layout = { devices: DevPlace[]; text: TextPlace; rings?: boolean; none?: boolean };

/**
 * @param W slide width, @param H slide height, @param a device aspect ratio (width / height).
 */
export function layout(t: TemplateId, W: number, H: number, a: number): Layout {
  const fit = (wMax: number, hMax: number) => Math.min(wMax, hMax * a);
  const centerText: TextPlace = { x: W * 0.5, y: H * 0.07, w: W * 0.86, align: "center", scale: 1, maxLines: 3 };
  switch (t) {
    case "crop":
      return { text: centerText, devices: [{ x: W * 0.5, top: H * 0.35, w: fit(W * 0.9, H * 0.9), rot: 0, shotOffset: 0 }] };
    case "textBottom": {
      const w = fit(W * 0.8, H * 0.64);
      return {
        text: { x: W * 0.5, y: H * 0.71, w: W * 0.86, align: "center", scale: 1, maxLines: 3 },
        devices: [{ x: W * 0.5, top: H * 0.66 - w / a, w, rot: 0, shotOffset: 0 }],
      };
    }
    case "tilt":
      return {
        text: { x: W * 0.08, y: H * 0.07, w: W * 0.84, align: "left", scale: 1, maxLines: 3 },
        devices: [{ x: W * 0.58, top: H * 0.32, w: fit(W * 0.8, H * 0.72), rot: -0.13, shotOffset: 0 }],
      };
    case "duo":
      return {
        text: centerText,
        devices: [
          { x: W * 0.3, top: H * 0.43, w: fit(W * 0.58, H * 0.55), rot: 0.06, shotOffset: 1 },
          { x: W * 0.67, top: H * 0.31, w: fit(W * 0.66, H * 0.62), rot: -0.04, shotOffset: 0 },
        ],
      };
    case "bridge":
      return {
        text: { x: W * 0.08, y: H * 0.07, w: W * 0.84, align: "left", scale: 1, maxLines: 3 },
        devices: [{ x: W, top: H * 0.31, w: fit(W * 0.8, H * 0.7), rot: -0.05, shotOffset: 0 }],
      };
    case "tail":
      return { text: { x: W * 0.92, y: H * 0.07, w: W * 0.84, align: "right", scale: 1, maxLines: 3 }, devices: [] };
    case "bigType":
      return {
        text: { x: W * 0.08, y: H * 0.06, w: W * 0.84, align: "left", scale: 1.32, maxLines: 4 },
        devices: [{ x: W * 0.68, top: H * 0.56, w: fit(W * 0.62, H * 0.5), rot: 0.1, shotOffset: 0 }],
      };
    case "rings":
      return { text: centerText, rings: true, devices: [{ x: W * 0.5, top: H * 0.32, w: fit(W * 0.72, H * 0.68), rot: 0, shotOffset: 0 }] };
    case "hero":
    default:
      return { text: centerText, devices: [{ x: W * 0.5, top: H * 0.31, w: fit(W * 0.74, H * 0.7), rot: 0, shotOffset: 0 }] };
  }
}
