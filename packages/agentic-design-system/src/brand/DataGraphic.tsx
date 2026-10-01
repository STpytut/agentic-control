"use client";

import { useEffect, useRef } from "react";
import { cx } from "../lib/cx";

type Node = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  accent: boolean;
};

const NODE_COUNT = 30;
const LINK_DISTANCE = 0.34; // share of the shorter canvas edge
const POINTER_RADIUS = 0.28;

/**
 * Abstract network of data points. Nodes drift slowly, links appear between
 * neighbours, and the pointer nudges nearby nodes. Renders a single static
 * frame under prefers-reduced-motion and pauses while off-screen.
 */
export function DataGraphic({ className = "", label }: { className?: string; label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Colours come from the theme, so the graphic follows data-theme="dark".
    let ink = "17, 17, 17";
    let accent = "#c8ff3d";
    function readPalette() {
      const style = getComputedStyle(canvas!);
      ink = (style.color.match(/[\d.]+/g) ?? ["17", "17", "17"]).slice(0, 3).join(", ");
      accent = style.getPropertyValue("--color-accent").trim() || accent;
    }
    let width = 0;
    let height = 0;
    let raf = 0;
    let running = false;
    const pointer = { x: -1, y: -1, active: false };

    const random = mulberry32(20260908);
    const nodes: Node[] = Array.from({ length: NODE_COUNT }, () => ({
      x: random(),
      y: random(),
      vx: (random() - 0.5) * 0.00028,
      vy: (random() - 0.5) * 0.00028,
      r: 1.6 + random() * 2.4,
      accent: random() > 0.82,
    }));

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      const min = Math.min(width, height);
      const linkDist = min * LINK_DISTANCE;
      ctx!.clearRect(0, 0, width, height);

      // Links first so nodes sit on top.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const ax = nodes[i].x * width;
          const ay = nodes[i].y * height;
          const bx = nodes[j].x * width;
          const by = nodes[j].y * height;
          const d = Math.hypot(ax - bx, ay - by);
          if (d > linkDist) continue;
          const alpha = (1 - d / linkDist) * 0.36;
          ctx!.strokeStyle = `rgba(${ink}, ${alpha.toFixed(3)})`;
          ctx!.lineWidth = 1;
          ctx!.beginPath();
          ctx!.moveTo(ax, ay);
          ctx!.lineTo(bx, by);
          ctx!.stroke();
        }
      }

      for (const node of nodes) {
        const x = node.x * width;
        const y = node.y * height;
        ctx!.beginPath();
        ctx!.arc(x, y, node.r, 0, Math.PI * 2);
        ctx!.fillStyle = node.accent ? accent : `rgba(${ink}, 0.8)`;
        ctx!.fill();
        if (node.accent) {
          ctx!.strokeStyle = `rgba(${ink}, 0.5)`;
          ctx!.lineWidth = 1;
          ctx!.stroke();
        }
      }
    }

    function step() {
      const min = Math.min(width, height) || 1;
      const pr = POINTER_RADIUS;

      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;

        if (node.x < 0.02 || node.x > 0.98) node.vx *= -1;
        if (node.y < 0.02 || node.y > 0.98) node.vy *= -1;
        node.x = clamp(node.x, 0.02, 0.98);
        node.y = clamp(node.y, 0.02, 0.98);

        if (pointer.active) {
          const dx = node.x - pointer.x;
          const dy = ((node.y - pointer.y) * height) / min;
          const d = Math.hypot(dx, dy);
          if (d < pr && d > 0.0001) {
            const push = (1 - d / pr) * 0.0016;
            node.x = clamp(node.x + (dx / d) * push, 0.02, 0.98);
            node.y = clamp(node.y + (dy / d) * push, 0.02, 0.98);
          }
        }
      }

      draw();
      raf = requestAnimationFrame(step);
    }

    function start() {
      if (running || reduced) return;
      running = true;
      raf = requestAnimationFrame(step);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    function onPointerMove(event: PointerEvent) {
      if (event.pointerType !== "mouse") return;
      const rect = canvas!.getBoundingClientRect();
      pointer.x = (event.clientX - rect.left) / rect.width;
      pointer.y = (event.clientY - rect.top) / rect.height;
      pointer.active =
        pointer.x >= -0.2 && pointer.x <= 1.2 && pointer.y >= -0.2 && pointer.y <= 1.2;
    }

    function onPointerLeave() {
      pointer.active = false;
    }

    readPalette();
    resize();
    draw();

    const resizeObserver = new ResizeObserver(() => {
      resize();
      draw();
    });
    resizeObserver.observe(canvas);

    const visibility = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? start() : stop()),
      { threshold: 0 },
    );
    visibility.observe(canvas);

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    canvas.addEventListener("pointerleave", onPointerLeave);
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      resizeObserver.disconnect();
      visibility.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={cx("text-ink", className)}
      role={label ? "img" : "presentation"}
      aria-label={label}
    />
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Deterministic PRNG so the layout is identical on every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
