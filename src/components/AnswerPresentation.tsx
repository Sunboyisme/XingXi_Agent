import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  Download,
  ExternalLink as ExternalLinkIcon,
  ChevronDown,
  Globe2,
} from "lucide-react";
import { ExternalLink } from "./ExternalLink";
import { FileCard } from "./OfficeFiles";
import { api, fetchApi, type Artifact, type Presentation } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export function ArtifactPicture({
  artifact,
  label,
}: {
  artifact: Artifact;
  label?: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true,
      objectUrl = "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    setUrl("");
    setError("");
    void fetchApi(`/artifacts/${artifact.id}/content`, {
      signal: controller.signal,
    })
      .then((r) => r.blob())
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (live) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {
        if (live) setError("图片加载失败");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timeout);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, attempt]);
  if (error)
    return (
      <button
        className="image-load-error"
        onClick={() => setAttempt(attempt + 1)}
      >
        {error}，重试
      </button>
    );
  if (!url) return <span className="image-loading">图片加载中…</span>;
  return (
    <span className="output-picture">
      <button
        className="picture-trigger"
        aria-label={`放大 ${label || artifact.name}`}
        onClick={() => setOpen(true)}
      >
        <img
          src={url}
          alt={label || artifact.name}
          onError={() => setError("图片加载失败")}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="output-image-dialog">
          <DialogHeader>
            <DialogTitle className="sr-only">{artifact.name}</DialogTitle>
            <DialogDescription className="sr-only">
              工具返回的图片
            </DialogDescription>
          </DialogHeader>
          <img src={url} alt={label || artifact.name} />
          <ArtifactDownload artifact={artifact} />
        </DialogContent>
      </Dialog>
    </span>
  );
}

export function RemotePicture({
  runId,
  src,
  alt,
}: {
  runId: string;
  src: string;
  alt: string;
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setArtifact(null);
    setError("");
    void api<Artifact>(`/runs/${runId}/images`, "POST", { url: src })
      .then((value) => {
        if (live) setArtifact(value);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [runId, src, attempt]);
  if (artifact) return <ArtifactPicture artifact={artifact} label={alt} />;
  return error ? (
    <button
      className="image-load-error"
      title={error}
      onClick={() => setAttempt(attempt + 1)}
    >
      图片加载失败，重试
    </button>
  ) : (
    <span className="image-loading">图片加载中…</span>
  );
}

function ArtifactDownload({ artifact }: { artifact: Artifact }) {
  const [error, setError] = useState("");
  return (
    <span className="artifact-download">
      <button
        onClick={async () => {
          try {
            setError("");
            if (isTauri()) {
              await api(`/artifacts/${artifact.id}/export`, "POST");
              await invoke("open_data_directory", { exports: true });
              return;
            }
            const response = await fetchApi(
              `/artifacts/${artifact.id}/content?download=true`,
            );
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = artifact.name;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <Download size={14} />
        {artifact.name}
      </button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}

export function AnswerPresentation({
  runId,
  status,
  content,
}: {
  runId?: string;
  status?: string;
  content: string;
}) {
  const [value, setValue] = useState<Presentation | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!runId) return;
    let live = true;
    setValue(null);
    setError("");
    void api<Presentation>(`/runs/${runId}/presentation`)
      .then((result) => {
        if (live && Array.isArray(result?.artifacts)) setValue(result);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [runId, status, attempt]);
  if (!runId) return null;
  return (
    <div className="answer-presentation">
      {error && (
        <button
          className="presentation-retry"
          title={error}
          onClick={() => setAttempt(attempt + 1)}
        >
          来源与产物暂不可用，重试
        </button>
      )}
      {value?.artifacts
        ?.filter((a) => !a.source_url || !content.includes(a.source_url))
        .map((artifact) =>
          artifact.image ? (
            <ArtifactPicture key={artifact.id} artifact={artifact} />
          ) : (
            <FileCard key={artifact.id} file={artifact} />
          ),
        )}
      {value?.image_urls
        ?.filter((url) => !content.includes(url))
        .map((url) => (
          <RemotePicture
            key={url}
            runId={runId}
            src={url}
            alt="工具返回的图片"
          />
        ))}
      {!!value?.sources?.length && (
        <details className="answer-sources">
          <summary>
            <Globe2 size={15} />
            参考网页 <span>{value.sources.length}</span>
            <ChevronDown size={15} className="disclosure-chevron" />
          </summary>
          <div>
            {value.sources.map((source) => (
              <ExternalLink
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <strong>
                  <ExternalLinkIcon size={13} />
                  {source.title}
                </strong>
                <small>
                  {source.kind === "read" ? "已读取正文" : "搜索摘要"} ·{" "}
                  {(() => {
                    try {
                      return new URL(source.url).hostname;
                    } catch {
                      return source.url;
                    }
                  })()}
                </small>
                {source.summary && <p>{source.summary}</p>}
              </ExternalLink>
            ))}
          </div>
        </details>
      )}
      {value?.errors?.map((message) => (
        <p className="presentation-notice" key={message}>
          {message}
        </p>
      ))}
    </div>
  );
}
