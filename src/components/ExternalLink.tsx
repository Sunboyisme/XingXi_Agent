import { invoke, isTauri } from "@tauri-apps/api/core";
import { useState, type ComponentProps } from "react";

// WebView2 does not route target=_blank to the user's default browser.
export function ExternalLink({
  href,
  children,
  onClick,
  ...props
}: ComponentProps<"a">) {
  const [error, setError] = useState("");
  const safe = typeof href === "string" && /^https?:\/\//i.test(href);
  return (
    <>
      <a
        {...props}
        href={safe ? href : undefined}
        target="_blank"
        rel="noopener noreferrer"
        onClick={async (event) => {
          onClick?.(event);
          if (event.defaultPrevented || !safe) return;
          if (isTauri()) {
            event.preventDefault();
            try {
              setError("");
              await invoke("open_external_url", { url: href });
            } catch {
              setError("无法打开网页，请重试或复制链接");
            }
          }
        }}
      >
        {children}
      </a>
      {error && (
        <span role="alert" className="external-link-error">
          {error}：{href}
        </span>
      )}
    </>
  );
}
