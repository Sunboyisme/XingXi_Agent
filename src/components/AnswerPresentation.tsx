import { KnowledgeSources } from "./KnowledgeSources";
import { DetailDialog } from "./ui/detail-dialog";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  Download,
  ExternalLink as ExternalLinkIcon,
  Globe2,
} from "lucide-react";
import { ExternalLink } from "./ExternalLink";
import {
  DownloadResultDialog,
  FileCard,
  type DownloadedFile,
} from "./OfficeFiles";
import {
  api,
  downloadApiFile,
  fetchApi,
  type Artifact,
  type Presentation,
} from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { errorMessage } from "@/lib/utils";

// Keep decoded pictures and resolved image artifacts for the session. Remounting
// a message (stream → persisted answer, page switch) must not flash blank again.
const pictureUrls = new Map<string, string>();
const imageArtifacts = new Map<string, Artifact>();

export function ArtifactPicture({
  artifact,
  label,
}: {
  artifact: Artifact;
  label?: string;
}) {
  const [url, setUrl] = useState(() => pictureUrls.get(artifact.id) || "");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const cached = pictureUrls.get(artifact.id);
    if (cached) {
      setUrl(cached);
      setError("");
      return;
    }
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
        if (live) {
          if (pictureUrls.size > 60)
            pictureUrls.delete(pictureUrls.keys().next().value!);
          pictureUrls.set(artifact.id, objectUrl);
          setUrl(objectUrl);
        } else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {
        if (live) setError("图片加载失败");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timeout);
      // Cached URLs are reused when the same message mounts again.
      if (!live && objectUrl && !pictureUrls.has(artifact.id))
        URL.revokeObjectURL(objectUrl);
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
  const [artifact, setArtifact] = useState<Artifact | null>(
    () => imageArtifacts.get(`${runId}:${src}`) || null,
  );
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const key = `${runId}:${src}`;
    const cached = imageArtifacts.get(key);
    if (cached) {
      setArtifact(cached);
      setError("");
      return;
    }
    let live = true;
    setArtifact(null);
    setError("");
    void api<Artifact>(`/runs/${runId}/images`, "POST", { url: src })
      .then((value) => {
        if (imageArtifacts.size > 100)
          imageArtifacts.delete(imageArtifacts.keys().next().value!);
        imageArtifacts.set(key, value);
        if (live) setArtifact(value);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [runId, src, attempt]);
  if (artifact) return <ArtifactPicture artifact={artifact} label={alt} />;
  return error ? (
    <button
      className="image-load-error"
      aria-label={`${error}，点击重试`}
      onClick={() => setAttempt(attempt + 1)}
    >
      图片加载失败，重试
    </button>
  ) : (
    <span className="image-loading">图片加载中…</span>
  );
}

export function ArtifactDownload({ artifact }: { artifact: Artifact }) {
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState<DownloadedFile | null>(null);
  const [webSaved, setWebSaved] = useState(false);
  return (
    <span className="artifact-download">
      <button
        onClick={async () => {
          try {
            setError("");
            if (isTauri()) {
              const path = await invoke<string>("download_office_file", {
                fileId: artifact.id,
                name: artifact.name,
                upload: false,
              });
              setDownloaded({ name: artifact.name, path });
              return;
            }
            await downloadApiFile(
              `/artifacts/${artifact.id}/content?download=true`,
              artifact.name,
            );
            setWebSaved(true);
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <Download size={14} />
        {artifact.name}
      </button>
      {webSaved && <span role="status">已下载</span>}
      {error && <span role="alert">{error}</span>}
      <DownloadResultDialog
        value={downloaded}
        onClose={() => setDownloaded(null)}
      />
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
    setError("");
    void api<Presentation>(`/runs/${runId}/presentation`)
      .then((result) => {
        if (live && Array.isArray(result?.artifacts)) setValue(result);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
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
          aria-label={`来源与产物暂不可用：${error}。点击重试`}
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
      <KnowledgeSources sources={value?.knowledge_sources} />
      {!!value?.sources?.length && (
        <DetailDialog
          title="参考网页"
          className="answer-sources"
          label={
            <>
              <Globe2 size={15} />
              参考网页 <span>{value.sources.length}</span>
            </>
          }
        >
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
        </DetailDialog>
      )}
      {value?.errors?.map((message) => (
        <p className="presentation-notice" key={message}>
          {message}
        </p>
      ))}
    </div>
  );
}
