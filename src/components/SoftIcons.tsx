import type { ReactNode } from "react";

export type SoftIconProps = { size?: number; className?: string };

/**
 * 侧栏与列表用的圆润图标：粗圆头线条，外形下方叠一层底色，
 * 由样式控制底色透明度（选中时淡淡填充，平时不显示）。
 */
function softIcon(name: string, shape: ReactNode, details?: ReactNode) {
  function Icon({ size = 20, className }: SoftIconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={className ? `soft-icon ${className}` : "soft-icon"}
      >
        <g className="soft-icon-fill" fill="currentColor" stroke="none">
          {shape}
        </g>
        {shape}
        {details}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

const dot = (cx: number, cy: number, r = 1) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

export const ChatIcon = softIcon(
  "ChatIcon",
  <path d="M7 9.5h4a4 4 0 0 1 4 4v.5a4 4 0 0 1-4 4H8.7l-3 2.15a.6.6 0 0 1-.95-.49v-2.07A4 4 0 0 1 3 14v-.5a4 4 0 0 1 4-4Z" />,
  <path d="M9.5 7A3.5 3.5 0 0 1 13 3.5h4.5A3.5 3.5 0 0 1 21 7v1a3.5 3.5 0 0 1-1.5 2.87v1.63a.5.5 0 0 1-.8.4L17 11.6" />,
);

export const ProjectIcon = softIcon(
  "ProjectIcon",
  <path d="M4 8.25A2.25 2.25 0 0 1 6.25 6h3.1c.55 0 1.07.24 1.43.65l.9 1.04c.36.41.88.65 1.43.65h4.64A2.25 2.25 0 0 1 20 10.6v6.15A2.25 2.25 0 0 1 17.75 19H6.25A2.25 2.25 0 0 1 4 16.75Z" />,
);

export const LearningIcon = softIcon(
  "LearningIcon",
  <path d="M12 7.4c-1.6-1.35-3.75-2-6.4-1.9A1.6 1.6 0 0 0 4 7.1v9.3c0 .88.73 1.58 1.6 1.6 2.55.05 4.7.7 6.4 1.95 1.7-1.25 3.85-1.9 6.4-1.95.87-.02 1.6-.72 1.6-1.6V7.1a1.6 1.6 0 0 0-1.6-1.6c-2.65-.1-4.8.55-6.4 1.9Z" />,
  <path d="M12 7.4v12.2" />,
);

export const PlanIcon = softIcon(
  "PlanIcon",
  <rect x="4" y="5.75" width="16" height="14" rx="3.5" />,
  <path d="M8.5 4v3.25M15.5 4v3.25M4.5 10.25h15" />,
);

export const KnowledgeIcon = softIcon(
  "KnowledgeIcon",
  <>
    <rect x="3.25" y="5" width="3.75" height="13.75" rx="1.25" />
    <rect x="9.5" y="7.5" width="3.5" height="11.25" rx="1.25" />
    <rect
      x="15"
      y="8.75"
      width="3.25"
      height="10"
      rx="1.25"
      transform="rotate(15 18.25 18.75)"
    />
  </>,
  <path d="M2.75 20.75h18.5" />,
);

export const CommonTextsIcon = softIcon(
  "CommonTextsIcon",
  <rect x="5" y="3.5" width="14" height="17" rx="3" />,
  <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />,
);

export const SettingsIcon = softIcon(
  "SettingsIcon",
  <>
    <circle cx="15.25" cy="8" r="2.25" />
    <circle cx="8.75" cy="16" r="2.25" />
  </>,
  <path d="M4.5 8H13M17.5 8h2M4.5 16h2M11 16h8.5" />,
);

export const ConnectionIcon = softIcon(
  "ConnectionIcon",
  <rect x="4.25" y="5.5" width="15.5" height="13" rx="3" />,
  <path d="M8 9.5h8M8 14.5h4.5" />,
);

export const MemoryIcon = softIcon(
  "MemoryIcon",
  <path d="M7.75 4.5h8.5A1.75 1.75 0 0 1 18 6.25v13a.5.5 0 0 1-.77.42L12 16.3l-5.23 3.37a.5.5 0 0 1-.77-.42v-13A1.75 1.75 0 0 1 7.75 4.5Z" />,
  <path d="M9.25 8.5h5.5" />,
);

export const HelpIcon = softIcon(
  "HelpIcon",
  <circle cx="12" cy="12" r="8" />,
  <>
    <path d="M9.75 9.75a2.25 2.25 0 1 1 3.1 2.08c-.5.21-.85.68-.85 1.22v.45" />
    {dot(12, 16.25)}
  </>,
);

export const TrashIcon = softIcon(
  "TrashIcon",
  <path d="M6.75 8.5h10.5l-.72 9.1a2 2 0 0 1-1.99 1.9H9.46a2 2 0 0 1-1.99-1.9Z" />,
  <path d="M5 8.5h14M9.75 8.5V6.75A1.75 1.75 0 0 1 11.5 5h1a1.75 1.75 0 0 1 1.75 1.75V8.5" />,
);
