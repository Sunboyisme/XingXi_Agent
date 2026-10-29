type EyePair = { left: SVGGElement; right: SVGGElement; range: number };
const targets = new Map<HTMLElement, EyePair>();
let tracker: { schedule: () => void; stop: () => void } | undefined;

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

export function projectAvatarEyes(horizontal: number, vertical: number) {
  const yaw = clamp(horizontal) * ((30 * Math.PI) / 180);
  const pitch = clamp(vertical) * ((10 * Math.PI) / 180);
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const camera = 110,
    faceDepth = 30,
    focalLength = camera - faceDepth;

  return [-7.5, 7.5].map((eyeX) => {
    // Rotate a shared face plane, then project each eye and its local axes.
    // At zero yaw/pitch both eyes are identical, upright and centred on x=44.
    const x = eyeX * cy + faceDepth * sy;
    const zYaw = -eyeX * sy + faceDepth * cy;
    const y = -8 * cp + zYaw * sp;
    const z = 8 * sp + zYaw * cp;
    const depth = camera - z;
    const scale = focalLength / depth;
    const dx = -sy * cp;
    const dy = -sp;

    return {
      a: scale * (cy + (x * dx) / depth),
      b: scale * (-sy * sp + (y * dx) / depth),
      c: (scale * x * dy) / depth,
      d: scale * (cp + (y * dy) / depth),
      x: 44 + x * scale,
      y: 44 + y * scale,
    };
  });
}

function eyeTransform(eye: ReturnType<typeof projectAvatarEyes>[number]) {
  return `matrix(${[eye.a, eye.b, eye.c, eye.d, eye.x, eye.y].map((value) => value.toFixed(5)).join(",")})`;
}

// Match the reference's relaxed, right-offset eyes without a head turn.
// Keep the resting eyes upright and equal; pointer tracking retains perspective.
export const RESTING_EYE_TRANSFORMS = projectAvatarEyes(0, 0).map(
  (eye, index) => eyeTransform({ ...eye, x: index === 0 ? 45 : 59, y: 41 }),
);

function resetEyes(eyes: EyePair) {
  eyes.left.style.removeProperty("transform");
  eyes.right.style.removeProperty("transform");
}

function startTracking() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let pointer: { x: number; y: number } | null = null;
  let frame = 0;

  function update() {
    frame = 0;
    if (!pointer || reducedMotion.matches || document.hidden) {
      targets.forEach(resetEyes);
      return;
    }

    // Read all positions before writing styles, once per animation frame.
    const positions = Array.from(targets, ([avatar, eyes]) => ({
      eyes,
      bounds: avatar.getBoundingClientRect(),
    }));
    for (const { eyes, bounds } of positions) {
      if (!bounds.width || !bounds.height) continue;
      const originX = bounds.left + bounds.width / 2;
      const originY = bounds.top + bounds.height * (36 / 88);
      const dx = pointer.x - originX,
        dy = pointer.y - originY;
      if (Math.hypot(dx, dy) > eyes.range) {
        resetEyes(eyes);
        continue;
      }
      // Use the available room on each side, including avatars near a window edge.
      const rangeX = Math.min(
        180,
        Math.max(1, dx < 0 ? originX : innerWidth - originX),
      );
      const rangeY = Math.min(
        160,
        Math.max(1, dy < 0 ? originY : innerHeight - originY),
      );
      const projections = projectAvatarEyes(dx / rangeX, dy / rangeY);
      [eyes.left, eyes.right].forEach((eye, index) => {
        eye.style.transform = eyeTransform(projections[index]);
      });
    }
  }

  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(update);
  }

  function reset() {
    pointer = null;
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    targets.forEach(resetEyes);
  }

  function move(event: PointerEvent) {
    if (event.pointerType !== "mouse") {
      reset();
      return;
    }
    if (reducedMotion.matches || document.hidden) return;
    pointer = { x: event.clientX, y: event.clientY };
    schedule();
  }

  function leave(event: PointerEvent) {
    if (!event.relatedTarget) reset();
  }

  function visibilityChanged() {
    if (document.hidden) reset();
  }

  function motionChanged() {
    if (reducedMotion.matches) reset();
  }

  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerout", leave);
  window.addEventListener("blur", reset);
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  document.addEventListener("visibilitychange", visibilityChanged);
  reducedMotion.addEventListener("change", motionChanged);

  return {
    schedule,
    stop() {
      reset();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", visibilityChanged);
      reducedMotion.removeEventListener("change", motionChanged);
    },
  };
}

export function followAvatarGaze(avatar: HTMLElement, eyes: SVGGElement, range = 160) {
  if (typeof window.matchMedia !== "function") return;
  const left = eyes.querySelector<SVGGElement>('[data-eye="left"]');
  const right = eyes.querySelector<SVGGElement>('[data-eye="right"]');
  if (!left || !right) return;
  const pair = { left, right, range };
  targets.set(avatar, pair);
  tracker ??= startTracking();
  tracker.schedule();

  return () => {
    resetEyes(pair);
    targets.delete(avatar);
    if (!targets.size) {
      tracker?.stop();
      tracker = undefined;
    }
  };
}
