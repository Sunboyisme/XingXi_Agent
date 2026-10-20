import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { followAvatarGaze, RESTING_EYE_TRANSFORMS } from "../lib/avatar-gaze";
import "../styles/bai-avatar.css";

type AvatarMotion = "idle" | "thinking" | "still";
const restingEyes = {
  "--bai-eye-rest-left": RESTING_EYE_TRANSFORMS[0],
  "--bai-eye-rest-right": RESTING_EYE_TRANSFORMS[1],
} as CSSProperties;

export function BaiAvatar({
  className,
  motion = "idle",
  interactive = false,
  onClick,
  label = "和XiaoXi打个招呼",
}: {
  className?: string;
  motion?: AvatarMotion;
  interactive?: boolean;
  onClick?: () => void;
  label?: string;
}) {
  const [reaction, setReaction] = useState(0);
  const gradientId = useId();
  const avatarRef = useRef<HTMLSpanElement>(null);
  const gazeRef = useRef<SVGGElement>(null);

  useEffect(() => {
    if (motion === "still" || !avatarRef.current || !gazeRef.current) return;
    return followAvatarGaze(avatarRef.current, gazeRef.current);
  }, [motion]);

  const artwork = (
    <span
      ref={avatarRef}
      className={["bai-avatar", !interactive && className]
        .filter(Boolean)
        .join(" ")}
      data-motion={motion}
      style={restingEyes}
      aria-hidden="true"
    >
      <span className="bai-avatar-response">
        <span className="bai-avatar-float">
          <svg viewBox="0 0 88 88" fill="none" focusable="false">
            <defs>
              <linearGradient
                id={gradientId}
                x1="25"
                y1="10"
                x2="64"
                y2="79"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="var(--bai-avatar-light, #d99c78)" />
                <stop
                  offset="0.55"
                  stopColor="var(--bai-avatar-fill, #c58265)"
                />
                <stop offset="1" stopColor="var(--bai-avatar-shade, #b76b50)" />
              </linearGradient>
            </defs>
            <path
              d="M43.6 10C46.4 10 49.3 10.3 52 11C54.7 11.7 57.3 12.9 59.8 14.2C62.3 15.5 64.7 17.2 66.8 19.1C68.9 21 70.8 23.2 72.5 25.6C74.2 27.9 75.7 30.5 76.9 33.3C78.2 36.1 79.4 39.1 79.9 42.3C80.4 45.4 80.5 48.8 80 52C79.5 55.2 78.3 58.5 76.7 61.3C75.1 64.2 72.8 66.9 70.4 69C67.9 71.2 65 72.9 62.1 74.2C59.2 75.6 56 76.4 52.9 77C49.8 77.6 46.7 77.9 43.6 78C40.5 78 37.3 77.8 34.2 77.2C31.1 76.6 28 75.7 25.1 74.3C22.2 72.9 19.3 71.1 16.9 68.9C14.5 66.8 12.4 64 10.9 61.1C9.4 58.3 8.4 54.9 8 51.8C7.6 48.6 7.7 45.3 8.2 42.3C8.7 39.2 9.7 36.2 10.9 33.5C12.1 30.8 13.6 28.2 15.2 25.9C16.9 23.5 18.8 21.4 20.8 19.5C22.9 17.6 25.2 15.8 27.6 14.5C30 13.1 32.6 12 35.3 11.3C38 10.5 40.8 10.1 43.6 10Z"
              fill={`url(#${gradientId})`}
            />
            <g
              className="bai-avatar-gaze"
              ref={gazeRef}
              fill="var(--bai-avatar-eyes, #fffcf8)"
            >
              {(["left", "right"] as const).map((side) => (
                <g className="bai-avatar-eye" data-eye={side} key={side}>
                  <g className="bai-avatar-eyes">
                    <rect
                      x="-3.3"
                      y="-6.3"
                      width="6.6"
                      height="12.6"
                      rx="3.3"
                    />
                  </g>
                </g>
              ))}
            </g>
          </svg>
        </span>
      </span>
    </span>
  );
  return interactive ? (
    <button
      type="button"
      className={["avatar-interaction", className].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
      data-reaction={reaction ? (reaction % 2 ? "happy" : "wave") : undefined}
      onClick={() => {
        setReaction((value) => value + 1);
        onClick?.();
      }}
    >
      {artwork}
    </button>
  ) : (
    artwork
  );
}
