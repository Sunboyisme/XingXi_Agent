import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { api, fetchApi } from "@/lib/api";
import {
  copyCommonTextImage,
  documentFor,
  type CommonTextAsset,
  type CommonTextDocument,
} from "@/lib/commonTextDocument";
import { errorMessage } from "@/lib/utils";
import { ErrorNotice } from "./common";
import { CommonTextPictureViewer } from "./CommonTextPictureViewer";

export function CommonTextPicture({
  id,
  children,
}: {
  id: string;
  children?: (asset: CommonTextAsset) => ReactNode;
}) {
  const [url, setUrl] = useState("");
  const [visible, setVisible] = useState(false);
  const figure = useRef<HTMLElement>(null);
  const [asset, setAsset] = useState<CommonTextAsset>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const node = figure.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const own = ++generation.current,
      controller = new AbortController();
    let objectUrl = "";
    setUrl("");
    setAsset(undefined);
    setError("");
    setCopied(false);
    setCopying(false);
    setViewing(false);
    void Promise.all([
      api<CommonTextAsset>(`/common-text-assets/${id}`, "GET", undefined, {
        signal: controller.signal,
      }),
      fetchApi(`/common-text-assets/${id}/content`, {
        signal: controller.signal,
      }).then((response) => response.blob()),
    ])
      .then(([meta, blob]) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setAsset(meta);
      })
      .catch((cause) => {
        if (generation.current === own && !controller.signal.aborted)
          setError(errorMessage(cause));
      });
    return () => {
      controller.abort();
      generation.current++;
      clearTimeout(timer.current);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, retry, visible]);
  return (
    <figure ref={figure} className="common-text-image">
      {url && asset ? (
        <button
          type="button"
          className="common-text-picture-trigger"
          aria-label={`放大查看 ${asset.name}`}
          onClick={() => setViewing(true)}
        >
          <img
            src={url}
            alt={asset.name}
            width={asset.width}
            height={asset.height}
            loading="lazy"
            draggable={false}
          />
        </button>
      ) : (
        !error && <p role="status">正在读取图片…</p>
      )}
      {asset && (
        <figcaption>
          <span>{asset.name}</span>
          <button
            type="button"
            disabled={copying}
            onClick={async () => {
              if (copying) return;
              const own = generation.current;
              setCopying(true);
              setError("");
              try {
                await copyCommonTextImage(id);
                if (generation.current === own) {
                  setCopied(true);
                  clearTimeout(timer.current);
                  timer.current = setTimeout(() => setCopied(false), 1800);
                }
              } catch (cause) {
                if (generation.current === own) setError(errorMessage(cause));
              } finally {
                if (generation.current === own) setCopying(false);
              }
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "已复制" : "复制图片"}
          </button>
          {children?.(asset)}
        </figcaption>
      )}
      {error && (
        <ErrorNotice
          message={error}
          retry={!url ? () => setRetry((n) => n + 1) : undefined}
        />
      )}
      {viewing && asset && url && (
        <CommonTextPictureViewer
          asset={asset}
          url={url}
          onClose={() => setViewing(false)}
        />
      )}
    </figure>
  );
}

export function CommonTextContent({
  value,
}: {
  value: { content: string; document?: CommonTextDocument | null };
}) {
  return (
    <div className="common-text-document">
      {documentFor(value).blocks.map((block, index) =>
        block.type === "text" ? (
          <p key={index} className="common-text-paragraph">
            {block.text}
          </p>
        ) : (
          <CommonTextPicture
            key={`${index}:${block.asset_id}`}
            id={block.asset_id}
          />
        ),
      )}
    </div>
  );
}
